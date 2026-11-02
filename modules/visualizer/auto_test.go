package visualizer

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
)

func autoOpts(mod func(*Options)) Options {
	o := DefaultOptions()
	o.Action = ActionAuto
	o.ShowJSON = `{"layers":[]}`
	if mod != nil {
		mod(&o)
	}
	return o
}

func TestRunAuto(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "My Song.mp3"))
	inst := writeFile(t, filepath.Join(dir, "inst.flac"))
	s := installSeams(t, media.Info{DurationMs: 60_000})

	var order []string
	var analyzedWith string
	analyzeFn = func(_ context.Context, _ *viz.Analyzer, job *core.JobContext, in string, o viz.AnalyzeOptions) (viz.AnalysisRef, error) {
		order = append(order, "analyze")
		s.analyzed, analyzedWith = o, in
		job.Progress(0.5, "analysing")
		return viz.AnalysisRef{Key: "fresh-s1-none-m1", Instrumental: inst, Summary: viz.AnalysisSummary{DurationMs: 60_000}}, nil
	}
	baseRender := renderFn
	renderFn = func(ctx context.Context, br *viz.RenderBroker, job *core.JobContext, p viz.RenderPlan) (viz.RenderOutput, error) {
		order = append(order, "render")
		job.Progress(0.5, "rendering")
		return baseRender(ctx, br, job, p)
	}

	o := autoOpts(func(o *Options) {
		o.Analyze.Stems, o.Analyze.Mood, o.Analyze.Words, o.Analyze.Language = true, true, viz.WordsDetect, "en"
		o.Audio = "instrumental"
		o.Aspect, o.Height, o.FPS = "9:16", 720, 60
	})
	var r recorder
	job := newJob(t, dir, "a1", o, song, &r)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(order, []string{"analyze", "render"}) {
		t.Errorf("order %v", order)
	}
	if analyzedWith != song || !s.analyzed.Stems || !s.analyzed.Mood || s.analyzed.Words != viz.WordsDetect || s.analyzed.Language != "en" {
		t.Errorf("analyze options %+v on %q", s.analyzed, analyzedWith)
	}
	if s.plan.Analysis.Key != "fresh-s1-none-m1" || s.plan.Width != 720 || s.plan.Height != 1280 || s.plan.FPS != 60 {
		t.Errorf("render plan uses the new analysis: %+v", s.plan)
	}
	if s.muxAudio != inst {
		t.Errorf("audio %q, want the instrumental", s.muxAudio)
	}
	res := decodeResult(t, &r)
	want := filepath.Join(job.OutputDir, "My Song (visualizer).mp4")
	if res.Action != ActionAuto || res.Analysis == nil || res.Analysis.Key != "fresh-s1-none-m1" ||
		len(res.Outputs) != 1 || res.Outputs[0] != want || res.Encoder != "h264-sw" {
		t.Errorf("result %+v", res)
	}
	if !strings.HasPrefix(r.title, "Visualizing — ") {
		t.Errorf("title %q", r.title)
	}

	// 0–40 % analyze, then 40–100 % render.
	if !slices.IsSorted(r.progress) {
		t.Errorf("progress not monotonic: %v", r.progress)
	}
	if !slices.Contains(r.progress, 0.2) { // analyze at 50 % of 0–0.4
		t.Errorf("analyze band missing: %v", r.progress)
	}
	if !slices.Contains(r.progress, autoAnalyzeEnd) {
		t.Errorf("no step at the end of the analysis: %v", r.progress)
	}
	if !slices.ContainsFunc(r.progress, func(p float64) bool { return p > 0.65 && p < 0.7 }) { // render at 50 % of 0.4–1, scaled by its own 0.9 share
		t.Errorf("render band missing: %v", r.progress)
	}
	if r.progress[len(r.progress)-1] != 1 {
		t.Errorf("must end at 1: %v", r.progress)
	}
}

func TestRunAutoOverlay(t *testing.T) {
	m, dir := newTestModule(t)
	clip := writeFile(t, filepath.Join(dir, "in", "clip.mp4"))
	s := installSeams(t, media.Info{DurationMs: 60_000, Video: &media.VideoStream{Width: 1920, Height: 1080, FPS: 30}})
	o := autoOpts(func(o *Options) { o.Mode = ModeOverlay; o.Analyze.Stems = false })
	var r recorder
	if err := m.Run(context.Background(), newJob(t, dir, "a2", o, clip, &r)); err != nil {
		t.Fatal(err)
	}
	if s.compBase != clip || s.compW != 1920 {
		t.Errorf("composite base %q width %d", s.compBase, s.compW)
	}
}

func TestRunAutoErrors(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))

	t.Run("analysis fails", func(t *testing.T) {
		s := installSeams(t, media.Info{DurationMs: 1000})
		boom := core.Errorf(core.CodeToolFailed, "boom")
		analyzeFn = func(context.Context, *viz.Analyzer, *core.JobContext, string, viz.AnalyzeOptions) (viz.AnalysisRef, error) {
			return viz.AnalysisRef{}, boom
		}
		var r recorder
		err := m.Run(context.Background(), newJob(t, dir, "e1", autoOpts(nil), song, &r))
		if !errors.Is(err, boom) || s.rendered != 0 {
			t.Errorf("err %v rendered %d", err, s.rendered)
		}
	})
	t.Run("instrumental the analysis lacks", func(t *testing.T) {
		s := installSeams(t, media.Info{DurationMs: 1000})
		var r recorder
		err := m.Run(context.Background(), newJob(t, dir, "e2", autoOpts(func(o *Options) { o.Audio = "instrumental" }), song, &r))
		var ae *core.AppError
		if !errors.As(err, &ae) || ae.Fields["audio"] == "" || s.rendered != 0 {
			t.Errorf("err %v rendered %d", err, s.rendered)
		}
	})
	t.Run("engine missing", func(t *testing.T) {
		installSeams(t, media.Info{DurationMs: 1000})
		var r recorder
		job := newJob(t, dir, "e3", autoOpts(nil), song, &r)
		// recorder tools always resolve; use a job whose Tool fails.
		raw, _ := json.Marshal(autoOpts(nil))
		job = core.NewJobContext(core.JobContext{ID: "e3", Inputs: []string{song}, Options: raw, OutputDir: job.OutputDir, TempDir: job.TempDir},
			core.JobHooks{Tool: func(id string) (string, error) { return "", core.ErrDependencyMissing(id, "install it") }})
		var ae *core.AppError
		if err := m.Run(context.Background(), job); !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
			t.Errorf("err %v", err)
		}
	})
}

func TestValidateAuto(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))
	video := writeFile(t, filepath.Join(dir, "in", "clip.mp4"))
	tests := []struct {
		name  string
		input string
		mod   func(*Options)
		want  string // field, "" = valid
	}{
		{"defaults", song, nil, ""},
		{"no design", song, func(o *Options) { o.ShowJSON = "" }, "showJson"},
		{"unreadable design", song, func(o *Options) { o.ShowJSON = "{" }, "showJson"},
		{"instrumental without stems", song, func(o *Options) { o.Audio = "instrumental"; o.Analyze.Stems = false }, "audio"},
		{"instrumental with stems", song, func(o *Options) { o.Audio = "instrumental" }, ""},
		{"overlay on audio", song, func(o *Options) { o.Mode = ModeOverlay }, "mode"},
		{"overlay on video", video, func(o *Options) { o.Mode = ModeOverlay }, ""},
		{"save stems without stems", song, func(o *Options) { o.Analyze.Stems = false; o.Analyze.SaveStems = true }, "analyze.saveStems"},
		{"pasted lyrics aren't a step input", song, func(o *Options) { o.Analyze.Words = viz.WordsAlign; o.Analyze.LyricsText = "la" }, "analyze.words"},
		{"detect words", song, func(o *Options) { o.Analyze.Words = viz.WordsDetect }, ""},
		{"bad height", song, func(o *Options) { o.Height = 900 }, "height"},
		{"no analysis key needed", song, func(o *Options) { o.AnalysisKey = "" }, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validateField(t, m, tt.input, autoOpts(tt.mod)); got != tt.want {
				t.Errorf("field %q, want %q", got, tt.want)
			}
		})
	}
}
