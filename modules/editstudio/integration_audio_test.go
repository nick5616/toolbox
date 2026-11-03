//go:build integration

package editstudio

import (
	"context"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// wavMillis reads a PCM WAV's length in ms from its data chunk.
func wavMillis(t *testing.T, path string) (ms float64, rate, channels int) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil || len(b) < 12 {
		t.Fatalf("read %s: %v", path, err)
	}
	var bytesPerFrame int
	for p := 12; p+8 <= len(b); {
		id, size := string(b[p:p+4]), int(binary.LittleEndian.Uint32(b[p+4:p+8]))
		body := p + 8
		switch id {
		case "fmt ":
			channels = int(binary.LittleEndian.Uint16(b[body+2:]))
			rate = int(binary.LittleEndian.Uint32(b[body+4:]))
			bytesPerFrame = channels * int(binary.LittleEndian.Uint16(b[body+14:])) / 8
		case "data":
			if size > len(b)-body { // streamed WAV: size unknown
				size = len(b) - body
			}
			return float64(size/bytesPerFrame) * 1000 / float64(rate), rate, channels
		}
		p = body + size + size%2
	}
	t.Fatal("no data chunk")
	return 0, 0, 0
}

func ffmpegOrSkip(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	return p
}

func TestIntegrationMixLengthIsExact(t *testing.T) {
	ffmpeg := ffmpegOrSkip(t)
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not on PATH")
	}
	dir := t.TempDir()
	gen := func(out string, args ...string) {
		t.Helper()
		full := append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)
		if b, err := exec.Command(ffmpeg, append(full, out)...).CombinedOutput(); err != nil {
			t.Fatalf("generate %s: %v\n%s", out, err, b)
		}
	}
	song := filepath.Join(dir, "song.wav")
	gen(song, "-f", "lavfi", "-i", "sine=frequency=440:duration=20:sample_rate=44100")
	clip := filepath.Join(dir, "clip.mp4")
	gen(clip, "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=880:duration=6",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest")

	cases := []struct {
		name   string
		start  int64
		end    int64
		mutate func(d *EditProject)
	}{
		{"song only", 2000, 9000, nil},
		{"song and clips", 3000, 14_321, func(d *EditProject) {
			d.Tracks[0].Clips = []Clip{
				{ID: "a", Kind: "video", Path: clip, StartMs: 500, EndMs: 2500, InMs: 1000, Volume: 1},
				{ID: "b", Kind: "video", Path: clip, StartMs: 3000, EndMs: 5000, InMs: 0, Volume: 0.5, Speed: "0.5"},
				{ID: "c", Kind: "video", Path: clip, StartMs: 6000, EndMs: 7000, InMs: 0, Volume: 1, Speed: "2"},
				{ID: "d", Kind: "video", Path: clip, StartMs: 10_000, EndMs: 20_000, InMs: 0, Volume: 1}, // runs past the end
			}
			d.CutOffsetFrames = 2
		}},
		{"song shorter than the edit is padded", 15_000, 24_000, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := NewProject("9:16", 30, 1)
			doc.Song = &Song{Path: song, StartMs: tc.start, EndMs: tc.end, GainDb: -3, FadeInMs: 200, FadeOutMs: 300}
			doc.Tracks = []Track{{ID: "t1", Kind: "video"}}
			if tc.mutate != nil {
				tc.mutate(&doc)
			}
			m := newTestModule(t)
			rec := &recorder{}
			job := newJob(t, t.TempDir(), Options{Action: ActionRender}, rec, map[string]string{"ffprobe": mustLook(t, "ffprobe"), "ffmpeg": ffmpeg})
			dst := filepath.Join(job.TempDir, "mix.wav")
			if err := m.mixAudio(context.Background(), job, doc, ffmpeg, dst); err != nil {
				t.Fatalf("mixAudio: %v", err)
			}
			ms, rate, ch := wavMillis(t, dst)
			want := float64(tc.end - tc.start)
			if rate != 48000 || ch != 2 {
				t.Errorf("format = %d Hz, %d ch", rate, ch)
			}
			if ms < want-1 || ms > want+1 {
				t.Errorf("length = %.3f ms, want %.0f ± 1", ms, want)
			}
		})
	}
}

func mustLook(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skip(name + " not on PATH")
	}
	return p
}
