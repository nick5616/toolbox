package viz

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// assFilter is the filter burning the subtitle file in the working directory.
func assFilter(ass string) string { return "ass=" + ass }

func seconds(ms int64) string {
	return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64)
}

func rawInput(out RenderOutput, fps int) []string {
	f := "h264"
	if out.Codec == "mjpeg" {
		f = "mjpeg"
	}
	return []string{"-f", f, "-framerate", strconv.Itoa(fps), "-i", out.Path}
}

var ffmpegHead = []string{"-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"}

// muxOpaqueArgs builds the MuxOpaque command line (SPEC.md §7.4, §9.6).
func muxOpaqueArgs(out RenderOutput, audio string, startMs, endMs int64, fps int, ass, dst string) []string {
	args := append([]string{}, ffmpegHead...)
	args = append(args, rawInput(out, fps)...)
	if startMs > 0 {
		args = append(args, "-ss", seconds(startMs))
	}
	if endMs > 0 {
		args = append(args, "-to", seconds(endMs))
	}
	args = append(args, "-i", audio, "-map", "0:v:0", "-map", "1:a:0")
	switch {
	case ass != "":
		args = append(args, "-vf", assFilter(ass), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p")
	case out.Codec == "mjpeg":
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p")
	default:
		args = append(args, "-c:v", "copy")
	}
	args = append(args, "-c:a", "aac", "-b:a", "192k")
	if out.Codec != "mjpeg" && ass == "" {
		// A raw Annex-B stream copied without re-encoding has no timestamps, so
		// -shortest would see a zero-length video and drop the audio: bound the
		// output by the video's length instead.
		// make_zero keeps a stream with B-frames from losing its first frames to an edit list.
		args = append(args, "-avoid_negative_ts", "make_zero")
		if out.Frames > 0 {
			args = append(args, "-t", strconv.FormatFloat(float64(out.Frames)/float64(fps), 'f', 3, 64))
		}
	} else {
		args = append(args, "-shortest")
	}
	return append(args, "-movflags", "+faststart", dst)
}

// overlayGraph is the filter_complex of CompositeOverlay.
func overlayGraph(fps, w, h int, loopBase bool, ass string) string {
	bg := fmt.Sprintf("[0:v]fps=%d", fps)
	if loopBase {
		bg += fmt.Sprintf(",scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1", w, h, w, h)
	}
	tail := "format=yuv420p"
	if ass != "" {
		tail += "," + assFilter(ass)
	}
	return "[1:v]split[a][b];[a]crop=iw:ih/2:0:0[c];[b]crop=iw:ih/2:0:ih/2,format=gray[m];" +
		fmt.Sprintf("[c][m]alphamerge,scale=%d:%d:flags=bicubic[ov];", w, h) +
		bg + "[bg];[bg][ov]overlay=0:0:format=auto:shortest=1," + tail + "[v]"
}

// compositeArgs builds the CompositeOverlay command line. copyAudio applies
// only when the audio comes from the base (audio == "").
func compositeArgs(out RenderOutput, base string, loopBase bool, audio string, fps, w, h int, ass, dst string, copyAudio bool) []string {
	args := append([]string{}, ffmpegHead...)
	if loopBase {
		args = append(args, "-stream_loop", "-1")
	}
	args = append(args, "-i", base)
	args = append(args, rawInput(out, fps)...)
	audioMap := "0:a:0?"
	if audio != "" {
		args = append(args, "-i", audio)
		audioMap = "2:a:0"
		copyAudio = false
	}
	args = append(args, "-filter_complex", overlayGraph(fps, w, h, loopBase, ass), "-map", "[v]", "-map", audioMap,
		"-c:v", "libx264", "-preset", "medium", "-crf", "18")
	if copyAudio {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	}
	return append(args, "-shortest", "-movflags", "+faststart", dst)
}

var audioCodecRe = regexp.MustCompile(`Audio: (\w+)`)

// baseAudioCopyable reports whether base's first audio stream is AAC or MP3.
func baseAudioCopyable(ctx context.Context, ffmpeg, base string) bool {
	var (
		mu    sync.Mutex
		codec string
	)
	_, _ = proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: []string{"-hide_banner", "-nostdin", "-i", base},
		OnStderr: func(l string) {
			if m := audioCodecRe.FindStringSubmatch(l); m != nil {
				mu.Lock()
				if codec == "" {
					codec = m[1]
				}
				mu.Unlock()
			}
		}})
	mu.Lock()
	defer mu.Unlock()
	return codec == "aac" || codec == "mp3"
}

// MuxOpaque muxes the rendered stream with audio (cut to startMs..endMs; 0 =
// whole). ass is "" or a subtitle file name in dst's job TempDir, burned in
// last, which forces a re-encode (SPEC.md §7.4, §9.6).
func MuxOpaque(ctx context.Context, ffmpeg string, out RenderOutput, audio string, startMs, endMs int64, fps int, ass, dst string, onProgress func(float64)) error {
	if fps <= 0 {
		return core.Errorf(core.CodeInternal, "Missing frame rate for the video")
	}
	args := muxOpaqueArgs(out, audio, startMs, endMs, fps, ass, dst)
	return runFFmpeg(ctx, ffmpeg, args, workDir(out, ass), float64(out.Frames)/float64(fps), "Finishing the video", onProgress)
}

// CompositeOverlay recombines a double-height colour/alpha stream, scales it
// to w×h and overlays it on base (looped when loopBase), with audio from
// audio ("" = base's own), burning in ass last (SPEC.md §7.4).
func CompositeOverlay(ctx context.Context, ffmpeg string, out RenderOutput, base string, loopBase bool, audio string, fps, w, h int, ass, dst string, onProgress func(float64)) error {
	if fps <= 0 || w <= 0 || h <= 0 {
		return core.Errorf(core.CodeInternal, "Missing size or frame rate for the video")
	}
	copyAudio := audio == "" && baseAudioCopyable(ctx, ffmpeg, base)
	args := compositeArgs(out, base, loopBase, audio, fps, w, h, ass, dst, copyAudio)
	return runFFmpeg(ctx, ffmpeg, args, workDir(out, ass), float64(out.Frames)/float64(fps), "Compositing", onProgress)
}

// workDir is the TempDir (where the stream and the ASS file live) when text
// is burned in, so the filtergraph never holds a path; otherwise "".
func workDir(out RenderOutput, ass string) string {
	if ass == "" {
		return ""
	}
	return filepath.Dir(out.Path)
}

func runFFmpeg(ctx context.Context, ffmpeg string, args []string, dir string, duration float64, label string, onProgress func(float64)) error {
	tracker := &media.ProgressTracker{Duration: duration, Label: label}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	report := func(p float64) {
		if onProgress != nil {
			onProgress(p)
		}
	}
	_, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: args, Dir: dir,
		OnStdout: func(l string) {
			mu.Lock()
			pct, _, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				report(pct)
			}
		},
		OnStderr: func(l string) {
			mu.Lock()
			lastStderr = l
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("ffmpeg cancelled: %w", ctxErr)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return fmt.Errorf("run ffmpeg: %w", err)
		}
		mu.Lock()
		msg := strings.TrimSpace(lastStderr)
		mu.Unlock()
		if msg == "" {
			msg = "ffmpeg failed"
		}
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	return nil
}
