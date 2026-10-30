package subtitles

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/lyrics"
	"toolbox/core/media"
	"toolbox/core/viz"
)

func TestCanvasSize(t *testing.T) {
	tests := []struct {
		canvas string
		height int
		w, h   int
	}{
		{"16:9", 1080, 1920, 1080}, {"16:9", 720, 1280, 720},
		{"9:16", 1080, 1080, 1920}, {"9:16", 720, 720, 1280},
		{"1:1", 1080, 1080, 1080}, {"1:1", 720, 720, 720},
		{"", 0, 1920, 1080},
	}
	for _, tt := range tests {
		w, h := canvasSize(Options{Canvas: tt.canvas, CanvasHeight: tt.height})
		if w != tt.w || h != tt.h || w%2 != 0 || h%2 != 0 {
			t.Errorf("%s/%d: %dx%d, want %dx%d", tt.canvas, tt.height, w, h, tt.w, tt.h)
		}
	}
}

func TestOverlaySizeAndFPS(t *testing.T) {
	if w, h := overlaySize(3840, 2160); w != 2560 || h != 1440 {
		t.Errorf("4k: %dx%d", w, h)
	}
	if w, h := overlaySize(1280, 720); w != 1280 || h != 720 {
		t.Errorf("720p: %dx%d", w, h)
	}
	if w, h := overlaySize(1081, 721); w != 1080 || h != 720 {
		t.Errorf("odd sizes must become even: %dx%d", w, h)
	}
	for in, want := range map[float64]int{0: 30, 23.976: 24, 29.97: 30, 25: 25, 47: 50, 59.94: 60, 120: 60, 15: 24} {
		if got := snapFPS(in); got != want {
			t.Errorf("snapFPS(%v) = %d, want %d", in, got, want)
		}
	}
}

func TestCueLines(t *testing.T) {
	cues := []Cue{{StartMs: 0, EndMs: 1000, Text: "hi there", Words: []CueWord{{0, 400, "hi"}, {400, 1000, "there"}}}}
	if l := cueLines(cues, false); len(l) != 1 || len(l[0].Words) != 0 || l[0].Text != "hi there" {
		t.Errorf("without words: %+v", l)
	}
	want := []lyrics.Word{{StartMs: 0, EndMs: 400, Text: "hi"}, {StartMs: 400, EndMs: 1000, Text: "there"}}
	if l := cueLines(cues, true); !reflect.DeepEqual(l[0].Words, want) {
		t.Errorf("with words: %+v", l)
	}
}

func TestBackgroundArgs(t *testing.T) {
	o := DefaultOptions()
	o.BackgroundColor = "#102030"
	got := strings.Join(backgroundArgs(o, 1280, 720, "song.mp3", "out.mp4"), " ")
	for _, want := range []string{"-f lavfi -i color=c=0x102030:s=1280x720:r=30", "-i song.mp3", "-map 1:a:0",
		"-vf format=yuv420p,ass=subs.ass", "-shortest", "-c:a aac", "out.mp4"} {
		if !strings.Contains(got, want) {
			t.Errorf("colour: missing %q in %s", want, got)
		}
	}
	o.Background, o.BackgroundPath = "image", "bg.jpg"
	got = strings.Join(backgroundArgs(o, 1080, 1920, "song.mp3", "out.mp4"), " ")
	for _, want := range []string{"-loop 1 -framerate 30 -i bg.jpg", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "ass=subs.ass"} {
		if !strings.Contains(got, want) {
			t.Errorf("image: missing %q in %s", want, got)
		}
	}
	o.Background, o.BackgroundColor = "color", "bad"
	if got := strings.Join(backgroundArgs(o, 10, 10, "a", "b"), " "); !strings.Contains(got, "0x11131a") {
		t.Errorf("bad colour must fall back: %s", got)
	}
}

type burnFakes struct {
	renders   []renderCall
	muxes     []string
	composite []string
	ffmpeg    [][]string
}

type renderCall struct {
	spec         viz.VisualsSpec
	lines        []lyrics.Line
	w, h, fps    int
	mode         viz.RenderMode
	p0, p1       float64
	rng          viz.Range
	input        string
	ffmpegWorkIn string
}

// installFakes replaces the burn seams; media is the probed Info.
func installFakes(t *testing.T, info media.Info) *burnFakes {
	t.Helper()
	f := &burnFakes{}
	oldProbe, oldRender, oldMux, oldComp, oldRun := probeFn, renderVisualsFn, muxFn, compositeFn, runFFmpegFn
	t.Cleanup(func() {
		probeFn, renderVisualsFn, muxFn, compositeFn, runFFmpegFn = oldProbe, oldRender, oldMux, oldComp, oldRun
	})
	probeFn = func(context.Context, string, string) (media.Info, error) { return info, nil }
	renderVisualsFn = func(_ context.Context, job *core.JobContext, _ *viz.Analyzer, _ *viz.RenderBroker, input string,
		spec viz.VisualsSpec, lines []lyrics.Line, w, h, fps int, mode viz.RenderMode, rng viz.Range, p0, p1 float64) (viz.RenderOutput, error) {
		f.renders = append(f.renders, renderCall{spec: spec, lines: lines, w: w, h: h, fps: fps, mode: mode, rng: rng, p0: p0, p1: p1, input: input})
		return viz.RenderOutput{Path: filepath.Join(job.TempDir, "visuals.h264"), Codec: "h264", Frames: 30}, nil
	}
	writeOut := func(dst string) error { return os.WriteFile(dst, []byte("mp4"), 0o644) }
	muxFn = func(_ context.Context, _ string, _ viz.RenderOutput, audio string, start, end int64, fps int, ass, dst string, _ func(float64)) error {
		f.muxes = append(f.muxes, strings.Join([]string{audio, ass}, "|"))
		if start != 0 || end != 0 || fps != 30 {
			t.Errorf("mux range %d-%d fps %d", start, end, fps)
		}
		return writeOut(dst)
	}
	compositeFn = func(_ context.Context, _ string, _ viz.RenderOutput, base string, loop bool, audio string, fps, w, h int, ass, dst string, _ func(float64)) error {
		f.composite = append(f.composite, strings.Join([]string{base, audio, ass}, "|"))
		if loop || audio != "" {
			t.Errorf("composite loop=%v audio=%q", loop, audio)
		}
		return writeOut(dst)
	}
	runFFmpegFn = func(_ context.Context, _ *core.JobContext, _, dir string, args []string, _ float64, _ string) error {
		f.ffmpeg = append(f.ffmpeg, args)
		if _, err := os.Stat(filepath.Join(dir, "subs.ass")); err != nil {
			t.Errorf("subs.ass missing: %v", err)
		}
		return writeOut(args[len(args)-1])
	}
	return f
}

func visualsOptions(mod func(*Options)) Options {
	return opts(func(o *Options) {
		o.Action = ActionBurn
		o.Cues = []Cue{{StartMs: 0, EndMs: 2000, Text: "hello world", Words: []CueWord{{0, 900, "hello"}, {900, 2000, "world"}}}}
		o.Visuals = &viz.VisualsSpec{ShowJSON: `{"v":1}`, UseWords: true}
		mod(o)
	})
}

func newVisualsModule() *Module { return &Module{an: &viz.Analyzer{}, br: &viz.RenderBroker{}} }

func TestRunBurnAudio(t *testing.T) {
	audio := media.Info{DurationMs: 60000, Audio: []media.AudioStream{{Codec: "mp3"}}}

	t.Run("visualizer", func(t *testing.T) {
		f := installFakes(t, audio)
		r := &recorder{}
		o := visualsOptions(func(o *Options) { o.Canvas, o.CanvasHeight = "9:16", 720 })
		if err := newVisualsModule().Run(context.Background(), newJob(t, r, "C:/in/talk.mp3", o)); err != nil {
			t.Fatal(err)
		}
		if len(f.renders) != 1 {
			t.Fatalf("renders %d", len(f.renders))
		}
		c := f.renders[0]
		if c.mode != viz.ModeOpaque || c.w != 720 || c.h != 1280 || c.fps != 30 || c.rng != (viz.Range{}) || c.p0 != 0 || c.p1 != renderShare {
			t.Errorf("render %+v", c)
		}
		if len(c.lines) != 1 || len(c.lines[0].Words) != 2 || !c.spec.UseWords {
			t.Errorf("lines %+v", c.lines)
		}
		if !reflect.DeepEqual(f.muxes, []string{"C:/in/talk.mp3|subs.ass"}) {
			t.Errorf("mux %v", f.muxes)
		}
		if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "talk (subtitled).mp4" {
			t.Errorf("outputs %v", r.outputs)
		}
	})

	t.Run("visualizer without words", func(t *testing.T) {
		f := installFakes(t, audio)
		o := visualsOptions(func(o *Options) { o.Visuals.UseWords = false })
		if err := newVisualsModule().Run(context.Background(), newJob(t, &recorder{}, "a.mp3", o)); err != nil {
			t.Fatal(err)
		}
		if len(f.renders[0].lines[0].Words) != 0 {
			t.Errorf("words must not be passed: %+v", f.renders[0].lines)
		}
	})

	for _, bg := range []string{"color", "image"} {
		t.Run(bg, func(t *testing.T) {
			f := installFakes(t, audio)
			r := &recorder{}
			img := writeFile(t, t.TempDir(), "bg.png", "x")
			o := visualsOptions(func(o *Options) {
				o.Visuals, o.Background, o.BackgroundPath = nil, bg, img
			})
			if err := newVisualsModule().Run(context.Background(), newJob(t, r, "a.mp3", o)); err != nil {
				t.Fatal(err)
			}
			if len(f.renders) != 0 || len(f.ffmpeg) != 1 {
				t.Fatalf("renders %d ffmpeg %d", len(f.renders), len(f.ffmpeg))
			}
			if j := strings.Join(f.ffmpeg[0], " "); !strings.Contains(j, "ass=subs.ass") || !strings.Contains(j, "-i a.mp3") {
				t.Errorf("args %s", j)
			}
			if len(r.outputs) != 1 {
				t.Errorf("outputs %v", r.outputs)
			}
		})
	}

	t.Run("without the visuals engine", func(t *testing.T) {
		installFakes(t, audio)
		if err := (&Module{}).Run(context.Background(), newJob(t, &recorder{}, "a.mp3", visualsOptions(func(*Options) {}))); err == nil {
			t.Error("expected an error")
		}
	})
}

func TestRunBurnOverlay(t *testing.T) {
	video := media.Info{DurationMs: 10000, Video: &media.VideoStream{Width: 3840, Height: 2160, FPS: 29.97}, Audio: []media.AudioStream{{Codec: "aac"}}}
	f := installFakes(t, video)
	r := &recorder{}
	if err := newVisualsModule().Run(context.Background(), newJob(t, r, "C:/in/clip.mp4", visualsOptions(func(*Options) {}))); err != nil {
		t.Fatal(err)
	}
	c := f.renders[0]
	if c.mode != viz.ModeOverlay || c.w != 2560 || c.h != 1440 || c.fps != 30 {
		t.Errorf("render %+v", c)
	}
	if !reflect.DeepEqual(f.composite, []string{"C:/in/clip.mp4||subs.ass"}) {
		t.Errorf("composite %v", f.composite) // ASS last, audio from the base
	}
	if len(f.muxes) != 0 || len(f.ffmpeg) != 0 {
		t.Error("only the composite should run")
	}
	if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "clip (subtitled).mp4" {
		t.Errorf("outputs %v", r.outputs)
	}
}

func TestRunBurnPlainVideoKeepsOldPath(t *testing.T) {
	video := media.Info{DurationMs: 10000, Video: &media.VideoStream{Width: 1280, Height: 720, FPS: 25}, Audio: []media.AudioStream{{Codec: "aac"}}}
	f := installFakes(t, video)
	o := visualsOptions(func(o *Options) { o.Visuals = nil })
	if err := newVisualsModule().Run(context.Background(), newJob(t, &recorder{}, "clip.mp4", o)); err != nil {
		t.Fatal(err)
	}
	if len(f.renders) != 0 || len(f.ffmpeg) != 1 || !strings.Contains(strings.Join(f.ffmpeg[0], " "), "-vf ass=subs.ass") {
		t.Errorf("renders %d ffmpeg %v", len(f.renders), f.ffmpeg)
	}
}

func TestRunBurnAudioNeedsBackground(t *testing.T) {
	installFakes(t, media.Info{DurationMs: 1000})
	o := visualsOptions(func(o *Options) { o.Visuals = nil }) // visualizer without a design
	if err := newVisualsModule().Run(context.Background(), newJob(t, &recorder{}, "a.mp3", o)); err == nil {
		t.Error("expected a validation error")
	}
}

func TestCheckStreamsAudioBurn(t *testing.T) {
	audio := media.Info{}
	for name, tt := range map[string]struct {
		o  Options
		ok bool
	}{
		"visualizer with design": {visualsOptions(func(*Options) {}), true},
		"visualizer no design":   {visualsOptions(func(o *Options) { o.Visuals = nil }), false},
		"colour":                 {visualsOptions(func(o *Options) { o.Background, o.Visuals = "color", nil }), true},
	} {
		if err := checkStreams(tt.o, audio); (err == nil) != tt.ok {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestValidateBurnVisuals(t *testing.T) {
	good := visualsOptions(func(*Options) {})
	if err := validateOptions(good); err != nil {
		t.Fatal(err)
	}
	for name, mod := range map[string]func(*Options){
		"empty design":   func(o *Options) { o.Visuals.ShowJSON = "" },
		"bad design":     func(o *Options) { o.Visuals.ShowJSON = "{" },
		"oversize":       func(o *Options) { o.Visuals.ShowJSON = `"` + strings.Repeat("a", viz.MaxShowBytes) + `"` },
		"bad canvas":     func(o *Options) { o.Canvas = "4:3" },
		"bad height":     func(o *Options) { o.CanvasHeight = 480 },
		"bad background": func(o *Options) { o.Background = "video" },
		"missing image":  func(o *Options) { o.Background, o.BackgroundPath = "image", "nope.png" },
		"bad colour":     func(o *Options) { o.BackgroundColor = "red" },
	} {
		o := visualsOptions(mod)
		if err := validateOptions(o); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
