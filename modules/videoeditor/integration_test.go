//go:build integration

package videoeditor

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"toolbox/core"
)

func ffmpegTools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	var err error
	if ffmpeg, err = exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if ffprobe, err = exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not installed")
	}
	return ffmpeg, ffprobe
}

func runCmd(t *testing.T, name string, args ...string) {
	t.Helper()
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
}

type probed struct {
	W, H     int
	FPS      string
	Duration float64
	HasAudio bool
}

func probeOut(t *testing.T, ffprobe, path string) probed {
	t.Helper()
	out, err := exec.Command(ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path).Output()
	if err != nil {
		t.Fatalf("ffprobe: %v", err)
	}
	var j struct {
		Streams []struct {
			CodecType  string `json:"codec_type"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			AvgFrame   string `json:"avg_frame_rate"`
			Duration   string `json:"duration"`
			SampleRate string `json:"sample_rate"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &j); err != nil {
		t.Fatal(err)
	}
	var p probed
	p.Duration, _ = strconv.ParseFloat(j.Format.Duration, 64)
	for _, s := range j.Streams {
		switch s.CodecType {
		case "video":
			p.W, p.H, p.FPS = s.Width, s.Height, s.AvgFrame
		case "audio":
			p.HasAudio = true
		}
	}
	return p
}

func testJob(t *testing.T, ffmpeg, ffprobe string) *core.JobContext {
	t.Helper()
	return core.NewJobContext(core.JobContext{ID: "t", TempDir: t.TempDir(), OutputDir: t.TempDir()}, core.JobHooks{
		Tool: func(id string) (string, error) {
			switch id {
			case "ffmpeg":
				return ffmpeg, nil
			case "ffprobe":
				return ffprobe, nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
		Progress: func(float64, string) {},
		Log:      func(core.LogStream, string) {},
	})
}

func TestIntegrationRender(t *testing.T) {
	ffmpeg, ffprobe := ffmpegTools(t)
	dir := t.TempDir()
	clip := func(name, size string, secs int, freq int) string {
		p := filepath.Join(dir, name)
		runCmd(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", fmt.Sprintf("testsrc=size=%s:rate=24:duration=%d", size, secs),
			"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%d:duration=%d", freq, secs),
			"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p)
		return p
	}
	a := clip("a.mp4", "640x360", 4, 440)
	b := clip("b.mp4", "360x640", 4, 550)
	c := clip("c.mp4", "480x480", 3, 660)
	photo := filepath.Join(dir, "p.png")
	runCmd(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=800x600:rate=1:duration=1", "-frames:v", "1", photo)
	song := filepath.Join(dir, "song.wav")
	runCmd(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=20", song)

	base := func(path, kind string) Clip {
		return Clip{ID: path, Kind: kind, Path: path, Speed: 1, Volume: 1, Fit: "fill", FitColor: "#000000", Zoom: 1,
			Motion: "none", Look: "none", Transition: Transition{Kind: "cut"}}
	}
	c1 := base(a, "video")
	c1.OutMs = 3000
	c1.Transition = Transition{Kind: "fade", DurationMs: 500}
	c2 := base(photo, "image")
	c2.DurationMs = 3000
	c2.Motion = "in"
	c2.Transition = Transition{Kind: "dip", DurationMs: 400}
	c3 := base(b, "video")
	c3.InMs, c3.OutMs, c3.Fit = 500, 3500, "fit-blur"
	c3.Look = "warm"
	c3.Transition = Transition{Kind: "slide", DurationMs: 300}
	c4 := base(c, "video")
	c4.OutMs, c4.Fit, c4.FitColor, c4.Speed = 3000, "fit-color", "#223344", 1.5
	doc := VideoProject{
		Version: 1, Aspect: "9:16", Clips: []Clip{c1, c2, c3, c4},
		Music:  &Music{Path: song, OffsetMs: 1000, Volume: 0.8, FadeInMs: 500, FadeOutMs: 1000, Duck: true},
		Titles: []Title{{ID: "t", Text: "Day one", StartMs: 500, DurationMs: 2000, Style: "title", Position: "center", Font: "Arial", Color: "#ffffff"}},
	}
	if err := validateDoc(normalize(doc)); err != nil {
		t.Fatal(err)
	}
	want := DurationMs(doc)

	m := New(Config{})
	job := testJob(t, ffmpeg, ffprobe)
	out := filepath.Join(t.TempDir(), "out.mp4")
	start := time.Now()
	if err := m.RenderProject(context.Background(), job, doc, out, RenderOptions{}); err != nil {
		t.Fatal(err)
	}
	took := time.Since(start)
	p := probeOut(t, ffprobe, out)
	if p.W != 1080 || p.H != 1920 {
		t.Errorf("size = %dx%d, want 1080x1920", p.W, p.H)
	}
	if p.FPS != "30/1" {
		t.Errorf("fps = %s", p.FPS)
	}
	if !p.HasAudio {
		t.Error("no audio stream")
	}
	if d := math.Abs(p.Duration*1000 - float64(want)); d > 1000.0/30+35 {
		t.Errorf("duration %.3f s, want %d ms (off %.0f ms)", p.Duration, want, d)
	}
	t.Logf("rendered %d ms of 1080x1920 in %s (%.1fx realtime)", want, took.Round(time.Millisecond), float64(want)/1000/took.Seconds())

	if keep := os.Getenv("VE_KEEP"); keep != "" { // visual QA: keep the render
		if b, err := os.ReadFile(out); err == nil {
			_ = os.WriteFile(filepath.Join(keep, "out.mp4"), b, 0o644)
		}
	}

	// Preview and a capped export of the same project.
	pv := filepath.Join(t.TempDir(), "pv.mp4")
	if err := m.RenderProject(context.Background(), job, doc, pv, RenderOptions{Preview: true, MaxSeconds: 5}); err != nil {
		t.Fatal(err)
	}
	pp := probeOut(t, ffprobe, pv)
	if pp.W != 540 || pp.H != 960 || pp.Duration > 5.1 {
		t.Errorf("preview = %dx%d %.2fs", pp.W, pp.H, pp.Duration)
	}
	if _, err := os.Stat(out + ".part"); err == nil {
		t.Error("leftover .part file")
	}
}

func TestIntegrationAspects(t *testing.T) {
	ffmpeg, ffprobe := ffmpegTools(t)
	dir := t.TempDir()
	a := filepath.Join(dir, "a.mp4")
	runCmd(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", a)
	for _, asp := range []struct {
		a    string
		w, h int
	}{{"4:5", 1080, 1350}, {"1:1", 1080, 1080}, {"16:9", 1920, 1080}} {
		for _, fit := range []string{"fill", "fit-blur", "fit-color"} {
			c := Clip{ID: "a", Kind: "video", Path: a, OutMs: 2000, Speed: 0.5, Volume: 0, Fit: fit, FitColor: "#112233", Zoom: 1.5, PanX: 0.5, Look: "noir", Transition: Transition{Kind: "cut"}}
			doc := VideoProject{Version: 1, Aspect: asp.a, Clips: []Clip{c}}
			out := filepath.Join(t.TempDir(), "o.mp4")
			job := testJob(t, ffmpeg, ffprobe)
			if err := New(Config{}).RenderProject(context.Background(), job, doc, out, RenderOptions{Preview: true}); err != nil {
				t.Fatalf("%s %s: %v", asp.a, fit, err)
			}
			p := probeOut(t, ffprobe, out)
			if min(p.W, p.H) != 540 {
				t.Errorf("%s %s: %dx%d", asp.a, fit, p.W, p.H)
			}
		}
	}
}
