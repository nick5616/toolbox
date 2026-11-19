package editstudio

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/viz"
)

// Muxing the rendered stream with the mix (Phase 21 SPEC §B6): codec,
// quality and audio rate come from the export settings. core/viz's MuxOpaque
// only copies H.264 at 192 kb/s, so the settings need their own command.

// muxSpec is how the stream and the mix become the MP4.
type muxSpec struct {
	FPS       int
	Codec     string // CodecH264 | CodecH265
	CRF       int
	Preset    string
	AudioKbps int
	// Reencode: decode the rendered stream and encode it again with Codec and CRF.
	// False copies an H.264 stream (an edit with no ExportSettings: the original behaviour).
	Reencode bool
	// The slice of the mix to use (the export range); both 0 = all of it.
	AudioStartMs, AudioLenMs int64
}

var ffmpegHead = []string{"-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"}

// editMuxArgs is the FFmpeg command line of the mux.
func editMuxArgs(out viz.RenderOutput, audio string, s muxSpec, dst string) []string {
	args := append([]string{}, ffmpegHead...)
	in := "h264"
	if out.Codec == "mjpeg" {
		in = "mjpeg"
	}
	args = append(args, "-f", in, "-framerate", strconv.Itoa(s.FPS), "-i", out.Path)
	if s.AudioStartMs > 0 {
		args = append(args, "-ss", mixMs(float64(s.AudioStartMs)))
	}
	if s.AudioLenMs > 0 {
		args = append(args, "-t", mixMs(float64(s.AudioLenMs)))
	}
	args = append(args, "-i", audio, "-map", "0:v:0", "-map", "1:a:0")
	copyVideo := !s.Reencode && out.Codec != "mjpeg"
	switch {
	case copyVideo:
		args = append(args, "-c:v", "copy")
	case s.Codec == CodecH265:
		args = append(args, "-c:v", "libx265", "-preset", s.Preset, "-crf", strconv.Itoa(s.CRF), "-pix_fmt", "yuv420p", "-tag:v", "hvc1")
	default:
		args = append(args, "-c:v", "libx264", "-preset", s.Preset, "-crf", strconv.Itoa(s.CRF), "-pix_fmt", "yuv420p")
	}
	kbps := s.AudioKbps
	if kbps <= 0 {
		kbps = defaultAudioKb
	}
	args = append(args, "-c:a", "aac", "-b:a", strconv.Itoa(kbps)+"k")
	if copyVideo {
		// A raw Annex-B stream copied without re-encoding has no timestamps, so
		// -shortest would see a zero-length video and drop the audio: bound the
		// output by the video's length instead. make_zero keeps a stream with
		// B-frames from losing its first frames to an edit list.
		args = append(args, "-avoid_negative_ts", "make_zero")
	}
	if out.Frames > 0 && s.FPS > 0 {
		args = append(args, "-t", strconv.FormatFloat(float64(out.Frames)/float64(s.FPS), 'f', 3, 64))
	} else {
		args = append(args, "-shortest")
	}
	return append(args, "-movflags", "+faststart", dst)
}

// muxEdit runs the mux and reports 0..1 progress.
func muxEdit(ctx context.Context, ffmpeg string, out viz.RenderOutput, audio string, s muxSpec, dst string, onProgress func(float64)) error {
	if s.FPS <= 0 {
		return core.Errorf(core.CodeInternal, "Missing frame rate for the video")
	}
	args := editMuxArgs(out, audio, s, dst)
	return runFFmpegProgress(ctx, ffmpeg, args, "", float64(out.Frames)/float64(s.FPS), "Finishing the video", onProgress)
}

// audioOnlyArgs encodes the mix as AAC in an .m4a (the range as -ss/-t).
func audioOnlyArgs(mix string, kbps int, startMs, lenMs int64, dst string) []string {
	args := append([]string{}, ffmpegHead...)
	if startMs > 0 {
		args = append(args, "-ss", mixMs(float64(startMs)))
	}
	if lenMs > 0 {
		args = append(args, "-t", mixMs(float64(lenMs)))
	}
	if kbps <= 0 {
		kbps = defaultAudioKb
	}
	return append(args, "-i", mix, "-vn", "-c:a", "aac", "-b:a", strconv.Itoa(kbps)+"k", "-ar", strconv.Itoa(mixRate), "-movflags", "+faststart", dst)
}

// encodeAudioOnly writes the .m4a of a mix. durMs is the length for progress.
func encodeAudioOnly(ctx context.Context, ffmpeg, mix string, kbps int, startMs, lenMs, durMs int64, dst string, onProgress func(float64)) error {
	return runFFmpegProgress(ctx, ffmpeg, audioOnlyArgs(mix, kbps, startMs, lenMs, dst), "", float64(durMs)/1000, "Saving the audio", onProgress)
}

// runFFmpegProgress runs FFmpeg (with -progress pipe:1) and maps a failure to
// a user-facing error; a cancel returns ctx's error and leaves dst removed by the caller.
func runFFmpegProgress(ctx context.Context, ffmpeg string, args []string, dir string, durSec float64, label string, onProgress func(float64)) error {
	tracker := &media.ProgressTracker{Duration: durSec, Label: label}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	_, err := runFFmpeg(ctx, proc.Spec{
		Path: ffmpeg, Args: args, Dir: dir,
		OnStdout: func(l string) {
			mu.Lock()
			pct, _, changed := tracker.Apply(l)
			mu.Unlock()
			if changed && pct >= 0 && onProgress != nil {
				onProgress(pct)
			}
		},
		OnStderr: func(l string) {
			if strings.TrimSpace(l) != "" {
				mu.Lock()
				lastStderr = l
				mu.Unlock()
			}
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return err
		}
		mu.Lock()
		msg := strings.TrimSpace(lastStderr)
		mu.Unlock()
		if msg == "" {
			msg = "ffmpeg failed"
		}
		return core.Errorf(core.CodeToolFailed, "Couldn't finish the file: %s", msg).WithCause(err)
	}
	if onProgress != nil {
		onProgress(1)
	}
	return nil
}

// ---- encoder availability ----

var encoderCache sync.Map // ffmpeg path + "|" + encoder → bool

// ffmpegHasEncoder reports (once per FFmpeg path) whether `ffmpeg -encoders`
// lists name.
func ffmpegHasEncoder(ctx context.Context, ffmpeg, name string) bool {
	key := ffmpeg + "|" + name
	if v, ok := encoderCache.Load(key); ok {
		return v.(bool)
	}
	found := false
	_, err := runFFmpeg(ctx, proc.Spec{
		Path: ffmpeg, Args: []string{"-hide_banner", "-encoders"},
		OnStdout: func(l string) {
			f := strings.Fields(l)
			if len(f) >= 2 && f[1] == name {
				found = true
			}
		},
	})
	if err != nil {
		return false // not cached: the failure may be a cancel
	}
	encoderCache.Store(key, found)
	return found
}

// exportEncoderFn is a seam for tests.
var exportEncoderFn = ffmpegHasEncoder
