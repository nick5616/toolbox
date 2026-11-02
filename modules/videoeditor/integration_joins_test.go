//go:build integration

package videoeditor

import (
	"context"
	"math"
	"path/filepath"
	"testing"
)

func TestIntegrationMixedJoins(t *testing.T) {
	ffmpeg, ffprobe := ffmpegTools(t)
	a := filepath.Join(t.TempDir(), "a.mp4")
	runCmd(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=3",
		"-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", a)
	mk := func(tr Transition) Clip {
		return Clip{ID: "a", Kind: "video", Path: a, OutMs: 2000, Speed: 1, Volume: 1, Fit: "fill", FitColor: "#000000", Zoom: 1, Motion: "none", Look: "none", Transition: tr}
	}
	cut := Transition{Kind: "cut"}
	doc := VideoProject{Version: 1, Aspect: "1:1", Clips: []Clip{
		mk(cut), mk(Transition{Kind: "fade", DurationMs: 500}), mk(cut), mk(cut), mk(Transition{Kind: "slide", DurationMs: 400}), mk(cut),
	}}
	out := filepath.Join(t.TempDir(), "o.mp4")
	if err := New(Config{}).RenderProject(context.Background(), testJob(t, ffmpeg, ffprobe), doc, out, RenderOptions{Preview: true}); err != nil {
		t.Fatal(err)
	}
	p := probeOut(t, ffprobe, out)
	want := float64(DurationMs(doc))
	if d := math.Abs(p.Duration*1000 - want); d > 70 {
		t.Errorf("duration %.3f s, want %.0f ms", p.Duration, want)
	}
}
