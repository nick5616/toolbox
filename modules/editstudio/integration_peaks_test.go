//go:build integration

package editstudio

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core/proc"
	"toolbox/core/viz"
)

// Real FFmpeg: `go test -tags integration -run 'IntegrationPrepareAudio|IntegrationMixGain' ./modules/editstudio/`.

func TestIntegrationPrepareAudioFiles(t *testing.T) {
	tools := realTools(t)
	m := realModule(t, tools)
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mp4")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", clip)
	silent := filepath.Join(dir, "silent.mp4")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1", "-pix_fmt", "yuv420p", "-c:v", "libx264", silent)
	song := filepath.Join(dir, "song.wav")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ar", "44100", song)

	o := Options{Action: ActionPrepare, Prepare: &PrepareRequest{Paths: []string{clip, silent, song}, FPS: 30}}
	job, rec := realJob(t, tools, o)
	if err := m.runPrepare(context.Background(), job, *o.Prepare); err != nil {
		t.Fatal(err)
	}
	_ = rec

	checkAudio := func(path string, wantMs int) {
		t.Helper()
		a, p := m.AudioFor(path)
		if a == "" || p == "" {
			t.Fatalf("%s: audio %q peaks %q", filepath.Base(path), a, p)
		}
		info, err := probeMedia(context.Background(), tools["ffprobe"], a)
		if err != nil || len(info.Audio) == 0 {
			t.Fatalf("probe %s: %v %+v", a, err, info)
		}
		if abs(int(info.DurationMs)-wantMs) > 120 {
			t.Errorf("audio.m4a is %d ms, want about %d", info.DurationMs, wantMs)
		}
		raw, _ := os.ReadFile(p)
		if !bytes.HasPrefix(raw, []byte(peaksHeader)) {
			t.Fatalf("peaks header: %q", raw[:min(len(raw), 40)])
		}
		pairs := (len(raw) - len(peaksHeader)) / 2
		if abs(pairs-wantMs/10) > 12 {
			t.Errorf("%d peak pairs, want about %d", pairs, wantMs/10)
		}
		var loud int
		for i := len(peaksHeader); i+1 < len(raw); i += 2 {
			if int8(raw[i+1]) > 8 {
				loud++
			}
		}
		if loud < pairs/2 {
			t.Errorf("a sine wave should be loud in most windows: %d of %d", loud, pairs)
		}
	}
	checkAudio(clip, 2000)
	checkAudio(song, 3000)

	if a, p := m.AudioFor(silent); a != "" || p != "" {
		t.Errorf("a video without sound got audio files: %q %q", a, p)
	}
	songDir, _ := m.srcDir(song)
	if streams, _ := filepath.Glob(filepath.Join(songDir, "*.h264")); len(streams) != 0 {
		t.Errorf("an audio file got a video stream: %v", streams)
	}
	if got := m.StreamFor(clip, PreviewShort(640, 360), 30); got == nil {
		t.Error("the video's stream is missing")
	}
}

// pcmSamples reads a WAV's s16 samples (first channel only is enough for a mono/duplicated mix).
func pcmSamples(t *testing.T, path string) []int16 {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for p := 12; p+8 <= len(b); {
		id, size := string(b[p:p+4]), int(binary.LittleEndian.Uint32(b[p+4:p+8]))
		body := p + 8
		if id == "data" {
			if size > len(b)-body {
				size = len(b) - body
			}
			out := make([]int16, size/2)
			for i := range out {
				out[i] = int16(binary.LittleEndian.Uint16(b[body+2*i:]))
			}
			return out
		}
		p = body + size + size%2
	}
	t.Fatal("no data chunk")
	return nil
}

func rms(s []int16) float64 {
	var sum float64
	for _, v := range s {
		sum += float64(v) * float64(v)
	}
	return math.Sqrt(sum / float64(max(len(s), 1)))
}

// The gain-key expression must be accepted by real FFmpeg (quoting, eval=frame)
// and do what it says: a ramp from 0 dB to −60 dB over 2 s.
func TestIntegrationMixGainKeysRealFFmpeg(t *testing.T) {
	tools := realTools(t)
	m := realModule(t, tools)
	dir := t.TempDir()
	tone := filepath.Join(dir, "tone.wav")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "48000", tone)

	doc := NewProject("9:16", 30, 1)
	doc.Tracks = []Track{{ID: "a1", Kind: "audio", Clips: []Clip{{
		ID: "x1", Kind: "audio", Path: tone, StartMs: 0, EndMs: 2000, Volume: 1,
		Gain:     `{"base":0,"keys":[{"t":0,"v":0,"ease":"linear"},{"t":2000,"v":-60,"ease":"ease"}]}`,
		FadeInMs: 0, FadeOutMs: 0,
	}}}}
	job, _ := realJob(t, tools, Options{})
	dst := filepath.Join(job.TempDir, "mix.wav")
	if err := m.mixAudio(context.Background(), job, doc, tools["ffmpeg"], dst); err != nil {
		t.Fatal(err)
	}
	s := pcmSamples(t, dst)
	frames := len(s) / 2 // stereo
	if ms := frames * 1000 / mixRate; abs(ms-2000) > 20 {
		t.Fatalf("mix is %d ms, want 2000", ms)
	}
	win := mixRate / 5 * 2 // 200 ms of stereo samples
	head, tail := rms(s[:win]), rms(s[len(s)-win:])
	if head < 1000 || tail > head/20 {
		t.Errorf("gain ramp: head rms %.0f, tail rms %.0f (want the tail at least 26 dB down)", head, tail)
	}
	// A muted track (and a solo elsewhere) leaves silence.
	doc.Tracks[0].Muted = true
	if err := m.mixAudio(context.Background(), job, doc, tools["ffmpeg"], dst); err != nil {
		t.Fatal(err)
	}
	if r := rms(pcmSamples(t, dst)); r > 1 {
		t.Errorf("muted track still heard: rms %.1f", r)
	}
}

// Real FFmpeg: the mux args for H.265 and for a trimmed mix produce a playable MP4
// of the right length and codec.
func TestIntegrationMuxSettings(t *testing.T) {
	tools := realTools(t)
	dir := t.TempDir()
	stream := filepath.Join(dir, "r.h264")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-bf", "0", "-f", "h264", stream)
	mix := filepath.Join(dir, "mix.wav")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "sine=frequency=330:duration=5", "-ar", "48000", "-ac", "2", mix)

	hasX265 := ffmpegHasEncoder(context.Background(), tools["ffmpeg"], "libx265")
	for _, codec := range []string{CodecH264, CodecH265} {
		if codec == CodecH265 && !hasX265 {
			continue
		}
		out := filepath.Join(dir, codec+".mp4")
		s := muxSpec{FPS: 30, Codec: codec, CRF: exportCRF(codec, QualityDraft), Preset: "veryfast", AudioKbps: 128, Reencode: true, AudioStartMs: 1000, AudioLenMs: 2000}
		if err := muxEdit(context.Background(), tools["ffmpeg"], viz.RenderOutput{Path: stream, Codec: "h264", Frames: 60}, mix, s, out, nil); err != nil {
			t.Fatalf("%s: %v", codec, err)
		}
		info, err := probeMedia(context.Background(), tools["ffprobe"], out)
		if err != nil || info.Video == nil || len(info.Audio) == 0 {
			t.Fatalf("%s probe: %v %+v", codec, err, info)
		}
		if abs(int(info.DurationMs)-2000) > 100 {
			t.Errorf("%s: %d ms, want 2000", codec, info.DurationMs)
		}
		var names strings.Builder
		_, _ = proc.Run(context.Background(), proc.Spec{Path: tools["ffprobe"], Args: []string{"-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", out},
			OnStdout: func(l string) { names.WriteString(strings.TrimSpace(l)) }})
		want := map[string]string{CodecH264: "h264", CodecH265: "hevc"}[codec]
		if names.String() != want {
			t.Errorf("%s: codec %q, want %q", codec, names.String(), want)
		}
	}
}
