//go:build integration

package trimmer

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
)

const defaultFFDir = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\smoke\bin\ffmpeg`

func ffTools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	dir := os.Getenv("TOOLBOX_TEST_FFMPEG_DIR")
	if dir == "" {
		dir = defaultFFDir
	}
	ffmpeg, ffprobe = filepath.Join(dir, "ffmpeg.exe"), filepath.Join(dir, "ffprobe.exe")
	for _, p := range []string{ffmpeg, ffprobe} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("FFmpeg not found at %s", p)
		}
	}
	return ffmpeg, ffprobe
}

// makeClip renders a 10 s 1280x720 30 fps clip with a 2 s GOP.
func makeClip(t *testing.T, ffmpeg, name string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), name)
	cmd := exec.Command(ffmpeg, "-v", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=10",
		"-c:v", "libx264", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-shortest", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make clip: %v\n%s", err, b)
	}
	return out
}

func runReal(t *testing.T, ffmpeg, ffprobe, input string, o Options) Result {
	t.Helper()
	m := &Module{resolve: func(id string) (string, error) {
		if id == "ffmpeg" {
			return ffmpeg, nil
		}
		return ffprobe, nil
	}}
	raw, _ := json.Marshal(o)
	if err := m.Validate([]string{input}, raw); err != nil {
		t.Fatalf("validate: %v", err)
	}
	var res Result
	job := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
		Result: func(b json.RawMessage) { _ = json.Unmarshal(b, &res) },
		Tool: func(id string) (string, error) {
			if id == "ffmpeg" {
				return ffmpeg, nil
			}
			return ffprobe, nil
		},
	})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}
	return res
}

func probe(t *testing.T, ffprobe, path string) media.Info {
	t.Helper()
	info, err := media.Probe(context.Background(), ffprobe, path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func near(t *testing.T, what string, gotMs, wantMs, tolMs int64) {
	t.Helper()
	d := gotMs - wantMs
	if d < -tolMs || d > tolMs {
		t.Errorf("%s = %d ms, want %d ± %d", what, gotMs, wantMs, tolMs)
	}
}

func TestIntegrationFastAndPrecise(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	for _, name := range []string{"clip.mp4", "clip.ts"} {
		input := makeClip(t, ffmpeg, name)
		segs := []Segment{{1000, 3000}, {5000, 7000}}

		fast := runReal(t, ffmpeg, ffprobe, input, opt(func(o *Options) { o.Segments = segs }))
		// Starts move back to a keyframe (<= 2 s each), so the result is
		// longer than 4 s by up to two GOPs.
		d := probe(t, ffprobe, fast.Outputs[0]).DurationMs
		if d < 3500 || d > 4000+4000+300 {
			t.Errorf("%s fast duration %d", name, d)
		}
		if fast.MaxShiftMs <= 0 || fast.MaxShiftMs > 2000 {
			t.Errorf("%s MaxShiftMs = %d", name, fast.MaxShiftMs)
		}

		prec := runReal(t, ffmpeg, ffprobe, input, opt(func(o *Options) { o.Segments = segs; o.Mode = ModePrecise }))
		info := probe(t, ffprobe, prec.Outputs[0])
		near(t, name+" precise duration", info.DurationMs, 4000, 70)
		if prec.MaxShiftMs != 0 || info.Video == nil || len(info.Audio) != 1 {
			t.Errorf("%s precise result %+v %+v", name, prec, info)
		}
	}
}

func TestIntegrationPortraitUnderLimit(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	input := makeClip(t, ffmpeg, "clip.mp4")
	res := runReal(t, ffmpeg, ffprobe, input, opt(func(o *Options) {
		o.Mode, o.Aspect, o.MaxSizeMB, o.MaxHeight = ModePrecise, AspectPortrait, 50, 720
		o.Segments = []Segment{{0, 10000}}
	}))
	fi, err := os.Stat(res.Outputs[0])
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() > 50*1024*1024 {
		t.Errorf("size %d over limit", fi.Size())
	}
	v := probe(t, ffprobe, res.Outputs[0]).Video
	if v == nil || v.Height != 720 || v.Width >= v.Height || v.Width != 404 && v.Width != 406 {
		t.Errorf("video %+v", v)
	}
}

func TestIntegrationAudioOnly(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	src := filepath.Join(t.TempDir(), "tone.mp3")
	if b, err := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=10", src).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	res := runReal(t, ffmpeg, ffprobe, src, opt(func(o *Options) { o.Mode = ModePrecise; o.Segments = []Segment{{2000, 6000}} }))
	near(t, "audio precise", probe(t, ffprobe, res.Outputs[0]).DurationMs, 4000, 80)
}
