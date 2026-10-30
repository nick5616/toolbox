package lyricvideo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
)

func visualsPlan(codec string) renderPlan {
	p := planFor("visualizer", "16:9", "wave")
	p.Visuals = viz.RenderOutput{Path: "visuals.h264", Codec: codec, Frames: 150}
	return p
}

func TestVisualsGraphAndArgs(t *testing.T) {
	p := visualsPlan("h264")
	g, out := p.filterGraph()
	if out != "[v]" || g != "[1:v]setsar=1,fps=30,format=yuv420p[bg];[bg]ass=subs.ass[v]" {
		t.Errorf("graph = %q (%s)", g, out)
	}
	a := strings.Join(p.args(), " ")
	for _, want := range []string{"-f h264 -framerate 30 -i visuals.h264", "-map [v] -map 0:a", "-i song.mp3"} {
		if !strings.Contains(a, want) {
			t.Errorf("args lack %q: %s", want, a)
		}
	}
	if strings.Contains(a, "[aout]") || strings.Contains(g, "showwaves") {
		t.Errorf("the strip must be hidden with visuals: %s", a)
	}

	m := strings.Join(visualsPlan("mjpeg").args(), " ")
	if !strings.Contains(m, "-f mjpeg -framerate 30 -i visuals.h264") || strings.Contains(m, "-f h264") {
		t.Errorf("mjpeg args: %s", m)
	}

	// Preview: the audio is cut, the background stream is not.
	pv := visualsPlan("h264")
	pv.StartMs, pv.DurMs, pv.OutName = 12500, 10000, "preview.mp4"
	args := pv.args()
	if i := argIndex(args, "-ss"); i < 0 || args[i+1] != "12.500" {
		t.Errorf("preview args: %v", args)
	}
	if strings.Count(strings.Join(args, " "), "-ss") != 1 {
		t.Errorf("only the audio input is seeked: %v", args)
	}
	// No path in the graph.
	if strings.Contains(g, "visuals.h264") {
		t.Errorf("graph has a path: %s", g)
	}
}

type fakeVisuals struct {
	calls []visualsCall
	err   error
}

type visualsCall struct {
	input        string
	spec         viz.VisualsSpec
	lines        int
	w, h, fps    int
	mode         viz.RenderMode
	rng          viz.Range
	p0, p1       float64
	haveAnalyzer bool
}

func (f *fakeVisuals) install(t *testing.T) {
	t.Helper()
	old, oldProbe := renderVisuals, probeMedia
	t.Cleanup(func() { renderVisuals, probeMedia = old, oldProbe })
	renderVisuals = func(ctx context.Context, job *core.JobContext, a *viz.Analyzer, b *viz.RenderBroker,
		input string, spec viz.VisualsSpec, lines []LyricLine, w, h, fps int, mode viz.RenderMode, rng viz.Range, p0, p1 float64) (viz.RenderOutput, error) {
		f.calls = append(f.calls, visualsCall{input, spec, len(lines), w, h, fps, mode, rng, p0, p1, a != nil})
		if f.err != nil {
			return viz.RenderOutput{}, f.err
		}
		return viz.RenderOutput{Path: filepath.Join(job.TempDir, "visuals.h264"), Codec: "h264", Frames: 10}, nil
	}
	probeMedia = func(ctx context.Context, ffprobe, path string) (media.Info, error) {
		return media.Info{DurationMs: 60_000}, nil
	}
}

func visualOptions(action Action, useWords bool) Options {
	o := DefaultOptions()
	o.Action = action
	o.Aspect, o.Height = "9:16", 720
	o.Lines = []LyricLine{{StartMs: 1000, EndMs: 2000, Text: "hello"}}
	o.Look.Background = "visualizer"
	o.Look.Visuals = viz.VisualsSpec{ShowJSON: `{"version":1}`, UseWords: useWords}
	return o
}

func TestRunVisualsRendersFirst(t *testing.T) {
	for _, tc := range []struct {
		name     string
		action   Action
		useWords bool
		start    int64
		wantRng  viz.Range
		wantTo   float64
		wantLine int
	}{
		{"full with words", ActionRender, true, 0, viz.Range{}, 0.6, 1},
		{"full without words", ActionRender, false, 0, viz.Range{}, 0.6, 0},
		{"preview range", ActionPreview, true, 20_000, viz.Range{StartMs: 20_000, EndMs: 30_000}, 0.8, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := visualOptions(tc.action, tc.useWords)
			o.PreviewStartMs = tc.start
			h := newHarness(t, o)
			h.m.an, h.m.br = viz.NewAnalyzer(t.TempDir(), t.TempDir(), nil, nil), &viz.RenderBroker{}
			fv := &fakeVisuals{}
			fv.install(t)
			// ffmpeg is a stand-in that does not exist: the run stops after the
			// background was rendered.
			err := h.m.Run(context.Background(), h.job)
			if err == nil || !strings.Contains(err.Error(), "ffmpeg") {
				t.Fatalf("err = %v, want an ffmpeg failure after the render", err)
			}
			if len(fv.calls) != 1 {
				t.Fatalf("RenderVisuals called %d times", len(fv.calls))
			}
			c := fv.calls[0]
			if c.input != h.song || c.w != 720 || c.h != 1280 || c.fps != 30 || c.mode != viz.ModeOpaque ||
				c.rng != tc.wantRng || c.p0 != 0 || c.p1 != tc.wantTo || c.lines != tc.wantLine || !c.haveAnalyzer {
				t.Errorf("call = %+v", c)
			}
			if _, err := os.Stat(filepath.Join(h.job.TempDir, "subs.ass")); err != nil {
				t.Errorf("the ASS script was not written: %v", err)
			}
		})
	}
}

func TestRunVisualsErrors(t *testing.T) {
	o := visualOptions(ActionRender, true)
	h := newHarness(t, o)
	if err := h.m.Run(context.Background(), h.job); !core.IsCode(err, core.CodeInternal) {
		t.Errorf("without the analyzer: %v", err)
	}
	h = newHarness(t, o)
	h.m.an, h.m.br = viz.NewAnalyzer(t.TempDir(), t.TempDir(), nil, nil), &viz.RenderBroker{}
	fv := &fakeVisuals{err: core.Errorf(core.CodeToolFailed, "render failed")}
	fv.install(t)
	if err := h.m.Run(context.Background(), h.job); !core.IsCode(err, core.CodeToolFailed) {
		t.Errorf("render error: %v", err)
	}
}

func TestValidateVisualizer(t *testing.T) {
	o := visualOptions(ActionRender, true)
	if err := validateOptions(o); err != nil {
		t.Errorf("valid: %v", err)
	}
	o.Look.Visuals.ShowJSON = ""
	if err := validateOptions(o); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("empty design: %v", err)
	}
	o.Look.Visuals.ShowJSON = strings.Repeat("x", viz.MaxShowBytes+1)
	if err := validateOptions(o); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("huge design: %v", err)
	}
}

func TestBestInstrumentalPrefersTheFourStemMix(t *testing.T) {
	h := newHarness(t, DefaultOptions())
	if got := h.m.bestInstrumental(h.song); got != "" {
		t.Errorf("nothing cached = %q", got)
	}
	// Lyric Video's own 2-stem cache.
	dir, _ := h.m.stemsDir(h.song)
	os.MkdirAll(dir, 0o755)
	two := filepath.Join(dir, instrumentalName)
	os.WriteFile(two, []byte("i"), 0o644)
	if got := h.m.bestInstrumental(h.song); got != two {
		t.Errorf("2-stem = %q", got)
	}
	// The Visualizer's 4-stem mix wins.
	h.m.an = viz.NewAnalyzer(t.TempDir(), t.TempDir(), nil, nil)
	key, _ := viz.FileKey(h.song)
	four := filepath.Join(h.m.an.CacheDir(), key, "instrumental.flac")
	os.MkdirAll(filepath.Dir(four), 0o755)
	os.WriteFile(four, []byte("i"), 0o644)
	if got := h.m.bestInstrumental(h.song); got != four {
		t.Errorf("4-stem = %q", got)
	}
}
