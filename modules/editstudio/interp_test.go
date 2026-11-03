package editstudio

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

func TestInterpRange(t *testing.T) {
	tests := []struct {
		from, to     int64
		wantF, wantT int64
	}{
		{0, 1000, 0, 1},
		{1200, 2800, 1, 3},
		{1999, 2001, 1, 3},
		{5000, 5001, 5, 6},
		{0, 29_999, 0, 30},
	}
	for _, tc := range tests {
		if f, to := InterpRange(tc.from, tc.to); f != tc.wantF || to != tc.wantT {
			t.Errorf("InterpRange(%d, %d) = %d, %d; want %d, %d", tc.from, tc.to, f, to, tc.wantF, tc.wantT)
		}
	}
}

func TestInterpFrameMs(t *testing.T) {
	tests := []struct {
		fromS   int64
		fps, n  int
		wantMs  int64
		comment string
	}{
		{0, 30, 0, 0, "first frame"},
		{0, 30, 120, 1000, "4 x 30 frames is one second"},
		{2, 30, 6, 2050, "6/120 s after 2 s"},
		{3, 60, 240, 4000, "60 fps"},
	}
	for _, tc := range tests {
		if got := InterpFrameMs(tc.fromS, tc.fps, tc.n); got != tc.wantMs {
			t.Errorf("%s: got %d, want %d", tc.comment, got, tc.wantMs)
		}
	}
}

func TestInterpArgs(t *testing.T) {
	args := interpArgs("in.h264", "out.part", 2, 5, 30, 16)
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-f h264 -framerate 30 -i in.h264", "-ss 2 -t 3",
		"-vf minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
		"-crf 16", "-g 10 -keyint_min 10", "-x264-params aud=1:repeat-headers=1 -f h264 out.part",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("%q missing from %s", want, joined)
		}
	}
	if interpName(2, 5, 30, TierExport) != "interp-2-5-120-export.h264" || interpName(2, 5, 30, TierPreview) != "interp-2-5-120-preview.h264" {
		t.Error("interp names")
	}
	if !strings.Contains(strings.Join(interpPreviewArgs("a", "b", 540, 960, 120), " "), "-framerate 120 -i a -vf scale=540:960") {
		t.Error("preview args")
	}
}

func TestEnsureInterp(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.frames = 40
	src := srcFile(t, "a.mov")
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	var prog []float64
	prev, exp, err := m.EnsureInterp(context.Background(), job, src, 200, 1500, 30, func(p float64) { prog = append(prog, p) })
	if err != nil {
		t.Fatal(err)
	}
	// 1080x1920 source: the export copy stays 1080 wide, the preview copy is 540.
	if exp.Width != 1080 || exp.Height != 1920 || exp.FPS != 120 {
		t.Errorf("export %+v", exp)
	}
	if prev.Width != 540 || prev.Height != 960 || prev.FPS != 120 {
		t.Errorf("preview %+v", prev)
	}
	if !strings.HasSuffix(exp.Stream, "interp-0-2-120-export.h264") || !strings.HasSuffix(prev.Stream, "interp-0-2-120-preview.h264") {
		t.Errorf("%s %s", exp.Stream, prev.Stream)
	}
	// input stream, minterpolate, preview scale
	if ff.count() != 3 {
		t.Errorf("%d ffmpeg runs", ff.count())
	}
	last := -1.0
	for _, p := range prog {
		if p < last-1e-9 {
			t.Fatalf("progress went back: %v", prog)
		}
		last = p
	}
	if last != 1 {
		t.Errorf("progress ended at %v", last)
	}
	if got := m.InterpFor(src, 200, 1500, 30, TierPreview); got == nil || *got != prev {
		t.Errorf("InterpFor preview = %+v", got)
	}
	if got := m.InterpFor(src, 300, 1900, 30, TierExport); got == nil || *got != exp {
		t.Errorf("InterpFor export = %+v (the range rounds out to whole seconds)", got)
	}
	if m.InterpFor(src, 200, 3500, 30, TierExport) != nil || m.InterpFor(src, 200, 1500, 60, TierExport) != nil {
		t.Error("other ranges and fps don't exist")
	}
	n := ff.count()
	if _, _, err := m.EnsureInterp(context.Background(), job, src, 0, 2000, 30, nil); err != nil || ff.count() != n {
		t.Errorf("reuse: %v, %d runs", err, ff.count())
	}
}

func TestEnsureInterpSmallSourceCopiesPreview(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.info.Video.Width, ff.info.Video.Height = 640, 360
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	prev, exp, err := m.EnsureInterp(context.Background(), job, srcFile(t, "a.mov"), 0, 1000, 30, nil)
	if err != nil {
		t.Fatal(err)
	}
	if prev.Width != 640 || exp.Width != 640 || ff.count() != 2 { // the input stream and minterpolate; the preview is a copy
		t.Errorf("%+v %+v %d", prev, exp, ff.count())
	}
	if prev.Stream == exp.Stream || prev.Frames != exp.Frames {
		t.Errorf("%+v %+v", prev, exp)
	}
}

func TestEnsureInterpErrors(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	src := srcFile(t, "a.mov")
	for _, tc := range []struct{ from, to int64 }{{500, 500}, {-1, 1000}, {900, 100}} {
		if _, _, err := m.EnsureInterp(context.Background(), job, src, tc.from, tc.to, 30, nil); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%d..%d: %v", tc.from, tc.to, err)
		}
	}
	if _, _, err := m.EnsureInterp(context.Background(), job, src, 5000, 6000, 30, nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("past the end: %v", err)
	}
	ff.delay = time.Second
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	if _, _, err := m.EnsureInterp(ctx, job, src, 0, 1000, 30, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: %v", err)
	}
	if m.InterpFor(src, 0, 1000, 30, TierExport) != nil {
		t.Error("a cancelled run leaves nothing")
	}
}

func TestRunInterp(t *testing.T) {
	m := newTestModule(t)
	installFakes(t)
	src := srcFile(t, "clip.mov")
	o := Options{Action: ActionInterp, Interp: &InterpRequest{Path: src, FromMs: 0, ToMs: 1000, FPS: 30}}
	var rec recorder
	job := newJob(t, t.TempDir(), o, &rec, fakeTools())
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if rec.title != "Slow motion — clip.mov" {
		t.Errorf("title = %q", rec.title)
	}
	var res Result
	if err := jsonUnmarshal(rec.result, &res); err != nil || res.Action != ActionInterp || res.Interp == nil || res.Interp.FPS != 120 {
		t.Errorf("%+v %v", res, err)
	}
}
