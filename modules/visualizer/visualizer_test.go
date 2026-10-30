package visualizer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/lyrics"
	"toolbox/core/media"
	"toolbox/core/viz"
)

func TestFullSize(t *testing.T) {
	cases := []struct {
		aspect string
		h      int
		w, ht  int
	}{
		{"16:9", 1080, 1920, 1080}, {"9:16", 1080, 1080, 1920}, {"1:1", 1080, 1080, 1080}, {"4:5", 1080, 1080, 1350},
		{"16:9", 720, 1280, 720}, {"9:16", 720, 720, 1280}, {"4:5", 720, 720, 900},
		{"16:9", 1440, 2560, 1440}, {"16:9", 2160, 3840, 2160}, {"9:16", 2160, 2160, 3840}, {"4:5", 2160, 2160, 2700},
	}
	for _, c := range cases {
		w, h := fullSize(c.aspect, c.h)
		if w != c.w || h != c.ht || w%2 != 0 || h%2 != 0 {
			t.Errorf("fullSize(%s,%d) = %dx%d, want %dx%d", c.aspect, c.h, w, h, c.w, c.ht)
		}
	}
}

func TestCapShort(t *testing.T) {
	cases := []struct{ w, h, limit, ow, oh int }{
		{1920, 1080, 1080, 1920, 1080},
		{3840, 2160, 1080, 1920, 1080},
		{2160, 3840, 1080, 1080, 1920},
		{2160, 2700, 1080, 1080, 1350},
		{1280, 720, 1080, 1280, 720},
	}
	for _, c := range cases {
		w, h := capShort(c.w, c.h, c.limit)
		if w != c.ow || h != c.oh {
			t.Errorf("capShort(%d,%d) = %dx%d, want %dx%d", c.w, c.h, w, h, c.ow, c.oh)
		}
	}
}

func TestOverlaySizes(t *testing.T) {
	cases := []struct{ vw, vh, fw, fh, pw, ph int }{
		{1920, 1080, 1920, 1080, 1920, 1080},
		{3840, 2160, 3840, 2160, 2560, 1440},
		{1080, 1920, 1080, 1920, 810, 1440},
		{481, 271, 482, 272, 568, 320}, // odd sizes are made even; tiny ones grow to the renderer's minimum
	}
	for _, c := range cases {
		fw, fh, pw, ph := overlaySizes(c.vw, c.vh)
		if fw != c.fw || fh != c.fh || pw != c.pw || ph != c.ph {
			t.Errorf("overlaySizes(%d,%d) = %d,%d,%d,%d want %d,%d,%d,%d", c.vw, c.vh, fw, fh, pw, ph, c.fw, c.fh, c.pw, c.ph)
		}
		if pw%2 != 0 || ph%2 != 0 {
			t.Errorf("odd plan size %dx%d", pw, ph)
		}
	}
}

func TestRoundFPS(t *testing.T) {
	cases := []struct {
		in   float64
		want int
	}{
		{0, 30}, {-1, 30}, {23.976, 24}, {24, 24}, {25, 25}, {29.97, 30}, {30, 30}, {48, 50}, {50, 50}, {59.94, 60}, {120, 60}, {12, 24},
	}
	for _, c := range cases {
		if got := roundFPS(c.in); got != c.want {
			t.Errorf("roundFPS(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestRenderRange(t *testing.T) {
	cases := []struct {
		name                    string
		preview                 bool
		start, end, pstart, dur int64
		from, to                int64
		ok                      bool
	}{
		{"whole", false, 0, 0, 0, 60_000, 0, 60_000, true},
		{"range", false, 5_000, 20_000, 0, 60_000, 5_000, 20_000, true},
		{"end past media", false, 0, 90_000, 0, 60_000, 0, 60_000, true},
		{"start past media", false, 70_000, 0, 0, 60_000, 70_000, 60_000, false},
		{"preview", true, 0, 0, 12_000, 60_000, 12_000, 22_000, true},
		{"preview near end", true, 0, 0, 55_000, 60_000, 55_000, 60_000, true},
		{"preview past end", true, 0, 0, 90_000, 60_000, 59_000, 60_000, true},
		{"preview ignores range", true, 5_000, 6_000, 0, 60_000, 0, 10_000, true},
		{"short media", true, 0, 0, 0, 4_000, 0, 4_000, true},
		{"no duration", false, 0, 0, 0, 0, 0, 0, false},
	}
	for _, c := range cases {
		from, to, ok := renderRange(c.preview, c.start, c.end, c.pstart, c.dur)
		if from != c.from || to != c.to || ok != c.ok {
			t.Errorf("%s: got %d,%d,%v want %d,%d,%v", c.name, from, to, ok, c.from, c.to, c.ok)
		}
	}
}

func TestChooseAudio(t *testing.T) {
	cases := []struct {
		audio, inst string
		overlay     bool
		want        string
	}{
		{"original", "", false, "in.mp3"},
		{"", "", false, "in.mp3"},
		{"original", "inst.flac", false, "in.mp3"},
		{"instrumental", "inst.flac", false, "inst.flac"},
		{"instrumental", "inst.flac", true, "inst.flac"},
		{"original", "", true, ""},
		{"instrumental", "", false, "in.mp3"},
	}
	for _, c := range cases {
		if got := chooseAudio(c.audio, "in.mp3", c.inst, c.overlay); got != c.want {
			t.Errorf("chooseAudio(%q,%q,%v) = %q, want %q", c.audio, c.inst, c.overlay, got, c.want)
		}
	}
}

func TestOutputName(t *testing.T) {
	if got := outputName(filepath.Join("x", "My Song.mp3")); got != "My Song (visualizer)" {
		t.Errorf("got %q", got)
	}
	if got := secs(1500); got != "1.500" {
		t.Errorf("secs = %q", got)
	}
}

func TestCutArgs(t *testing.T) {
	a := strings.Join(cutArgs("in.mp4", 1000, 3500, []string{"-c:a", "flac"}, "o.flac"), " ")
	if !strings.Contains(a, "-ss 1.000 -t 2.500 -i in.mp4 -c:a flac o.flac") {
		t.Errorf("args: %s", a)
	}
}

// ---- Validate -------------------------------------------------------------

func newTestModule(t *testing.T) (*Module, string) {
	t.Helper()
	dir := t.TempDir()
	an := viz.NewAnalyzer(filepath.Join(dir, "cache"), dir, nil, nil)
	m := &Module{an: an, previewDir: filepath.Join(dir, "previews"), modelsDir: filepath.Join(dir, "models")}
	return m, dir
}

func writeFile(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func putAnalysis(t *testing.T, m *Module, dir, key, instrumental string) viz.AnalysisRef {
	t.Helper()
	ref := viz.AnalysisRef{
		Key:          key,
		AudioJSON:    writeFile(t, filepath.Join(dir, "a", key+".json")),
		FeaturesPath: writeFile(t, filepath.Join(dir, "a", key+".bin")),
		Instrumental: instrumental,
		Summary:      viz.AnalysisSummary{DurationMs: 60_000},
	}
	if err := m.an.WriteRef(ref); err != nil {
		t.Fatal(err)
	}
	return ref
}

func renderOpts(key string) Options {
	o := DefaultOptions()
	o.Action = ActionRender
	o.AnalysisKey = key
	o.ShowJSON = `{"layers":[]}`
	return o
}

func validateField(t *testing.T, m *Module, input string, o Options) string {
	t.Helper()
	raw, _ := json.Marshal(o)
	err := m.Validate([]string{input}, raw)
	if err == nil {
		return ""
	}
	var ae *core.AppError
	if !asAppError(err, &ae) {
		t.Fatalf("not an AppError: %v", err)
	}
	for k := range ae.Fields {
		return k
	}
	return ae.Message
}

func asAppError(err error, out **core.AppError) bool {
	ae, ok := err.(*core.AppError)
	if ok {
		*out = ae
	}
	return ok
}

func TestValidate(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))
	video := writeFile(t, filepath.Join(dir, "in", "clip.mp4"))
	img := writeFile(t, filepath.Join(dir, "in", "bg.png"))
	bgv := writeFile(t, filepath.Join(dir, "in", "bg.mp4"))
	lrc := writeFile(t, filepath.Join(dir, "in", "l.lrc"))
	putAnalysis(t, m, dir, "k1-s0-none-m0", "")
	putAnalysis(t, m, dir, "k2-s1-none-m0", filepath.Join(dir, "inst.flac"))

	type tc struct {
		name  string
		input string
		mut   func(*Options)
		want  string // "" = valid, else the field
	}
	cases := []tc{
		{"analyze default", song, func(o *Options) {}, ""},
		{"analyze align no text", song, func(o *Options) { o.Analyze.Words = viz.WordsAlign }, "analyze.lyricsText"},
		{"analyze align", song, func(o *Options) { o.Analyze.Words = viz.WordsAlign; o.Analyze.LyricsText = "la la" }, ""},
		{"analyze file missing", song, func(o *Options) { o.Analyze.Words = viz.WordsFile; o.Analyze.LyricsPath = "nope.lrc" }, "analyze.lyricsPath"},
		{"analyze file", song, func(o *Options) { o.Analyze.Words = viz.WordsFile; o.Analyze.LyricsPath = lrc }, ""},
		{"analyze words bad", song, func(o *Options) { o.Analyze.Words = "x" }, "analyze.words"},
		{"analyze given bad order", song, func(o *Options) {
			o.Analyze.Words = viz.WordsGiven
			o.Analyze.Lines = []lyrics.Line{{StartMs: 2000, EndMs: 3000}, {StartMs: 1000, EndMs: 1500}}
		}, "analyze.lines.1"},
		{"analyze given ok", song, func(o *Options) {
			o.Analyze.Words = viz.WordsGiven
			o.Analyze.Lines = []lyrics.Line{{StartMs: 1000, EndMs: 3000}}
		}, ""},
		{"saveStems without stems", song, func(o *Options) { o.Analyze.Stems = false; o.Analyze.SaveStems = true }, "analyze.saveStems"},
		{"unknown action", song, func(o *Options) { o.Action = "x" }, "action"},
		{"render ok", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0") }, ""},
		{"render no key", song, func(o *Options) { *o = renderOpts("") }, "analysisKey"},
		{"render unknown key", song, func(o *Options) { *o = renderOpts("zz-s0-none-m0") }, "analysisKey"},
		{"render bad show", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.ShowJSON = "{" }, "showJson"},
		{"render huge show", song, func(o *Options) {
			*o = renderOpts("k1-s0-none-m0")
			o.ShowJSON = `"` + strings.Repeat("a", viz.MaxShowBytes) + `"`
		}, "showJson"},
		{"render bad aspect", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Aspect = "3:2" }, "aspect"},
		{"render bad height", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Height = 900 }, "height"},
		{"render bad fps", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.FPS = 24 }, "fps"},
		{"preview ok", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Action = ActionPreview }, ""},
		{"bg image ok", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Background = "image"; o.BackgroundPath = img }, ""},
		{"bg image wrong type", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Background = "image"; o.BackgroundPath = bgv }, "backgroundPath"},
		{"bg video ok", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Background = "video"; o.BackgroundPath = bgv }, ""},
		{"bg video missing", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Background = "video" }, "backgroundPath"},
		{"bg unknown", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Background = "x" }, "background"},
		{"overlay needs video", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Mode = ModeOverlay }, "mode"},
		{"overlay ok", video, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Mode = ModeOverlay }, ""},
		{"bad mode", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Mode = "x" }, "mode"},
		{"empty range", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.StartMs = 5000; o.EndMs = 4000 }, "endMs"},
		{"negative start", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.StartMs = -1 }, "endMs"},
		{"instrumental without stems", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Audio = "instrumental" }, "audio"},
		{"instrumental ok", song, func(o *Options) { *o = renderOpts("k2-s1-none-m0"); o.Audio = "instrumental" }, ""},
		{"bad audio", song, func(o *Options) { *o = renderOpts("k1-s0-none-m0"); o.Audio = "x" }, "audio"},
	}
	for _, c := range cases {
		o := DefaultOptions()
		c.mut(&o)
		if got := validateField(t, m, c.input, o); got != c.want {
			t.Errorf("%s: field %q, want %q", c.name, got, c.want)
		}
	}

	// Inputs.
	raw, _ := json.Marshal(DefaultOptions())
	if err := m.Validate(nil, raw); err == nil {
		t.Error("no inputs accepted")
	}
	if err := m.Validate([]string{song, video}, raw); err == nil {
		t.Error("two inputs accepted")
	}
	if err := m.Validate([]string{img}, raw); err == nil {
		t.Error("an image was accepted as input")
	}
}

// ---- Run ------------------------------------------------------------------

type recorder struct {
	result   json.RawMessage
	outputs  []string
	progress []float64
	title    string
}

func newJob(t *testing.T, dir, id string, o Options, input string, r *recorder) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(o)
	out, tmp := filepath.Join(dir, "lib"), filepath.Join(dir, "tmp-"+id)
	for _, d := range []string{out, tmp} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return core.NewJobContext(core.JobContext{ID: id, ModuleID: ModuleID, Inputs: []string{input}, Options: raw, OutputDir: out, TempDir: tmp},
		core.JobHooks{
			Progress: func(p float64, _ string) { r.progress = append(r.progress, p) },
			Title:    func(s string) { r.title = s },
			Output: func(p string) (core.Output, error) {
				r.outputs = append(r.outputs, p)
				return core.Output{Path: p}, nil
			},
			Tool:   func(id string) (string, error) { return id + "-bin", nil },
			Result: func(b json.RawMessage) { r.result = b },
		})
}

type seams struct {
	plan      viz.RenderPlan
	rendered  int
	muxAudio  string
	muxFrom   int64
	muxTo     int64
	compBase  string
	compAudio string
	compLoop  bool
	compW     int
	compH     int
	cutVideo  int
	cutAudio  int
	analyzed  viz.AnalyzeOptions
}

func installSeams(t *testing.T, info media.Info) *seams {
	t.Helper()
	s := &seams{}
	oa, or, om, oc, op, ocv, oca, ocvid, on := analyzeFn, renderFn, muxFn, compositeFn, probeFn, coverFn, cutAudioFn, cutVideoFn, nowFn
	t.Cleanup(func() {
		analyzeFn, renderFn, muxFn, compositeFn, probeFn, coverFn, cutAudioFn, cutVideoFn, nowFn = oa, or, om, oc, op, ocv, oca, ocvid, on
	})
	analyzeFn = func(_ context.Context, _ *viz.Analyzer, _ *core.JobContext, _ string, o viz.AnalyzeOptions) (viz.AnalysisRef, error) {
		s.analyzed = o
		return viz.AnalysisRef{Key: "kk-s1-none-m0", Summary: viz.AnalysisSummary{DurationMs: 1234}}, nil
	}
	renderFn = func(_ context.Context, _ *viz.RenderBroker, _ *core.JobContext, p viz.RenderPlan) (viz.RenderOutput, error) {
		s.plan = p
		s.rendered++
		return viz.RenderOutput{Path: "stream.h264", Codec: "h264", Frames: 10, Encoder: "h264-sw"}, nil
	}
	muxFn = func(_ context.Context, _ string, _ viz.RenderOutput, audio string, from, to int64, _ int, _ string, dst string, _ func(float64)) error {
		s.muxAudio, s.muxFrom, s.muxTo = audio, from, to
		return os.WriteFile(dst, []byte("mp4"), 0o644)
	}
	compositeFn = func(_ context.Context, _ string, _ viz.RenderOutput, base string, loop bool, audio string, _ int, w, h int, _ string, dst string, _ func(float64)) error {
		s.compBase, s.compLoop, s.compAudio, s.compW, s.compH = base, loop, audio, w, h
		return os.WriteFile(dst, []byte("mp4"), 0o644)
	}
	probeFn = func(context.Context, string, string) (media.Info, error) { return info, nil }
	coverFn = func(_ context.Context, _, _, dir string) (string, error) { return filepath.Join(dir, "cover.png"), nil }
	cutAudioFn = func(_ context.Context, _, src string, _, _ int64, dir string) (string, error) {
		s.cutAudio++
		return filepath.Join(dir, "audio-cut.flac"), nil
	}
	cutVideoFn = func(_ context.Context, _, src string, _, _ int64, dir string) (string, error) {
		s.cutVideo++
		return filepath.Join(dir, "base-cut.mp4"), nil
	}
	return s
}

func decodeResult(t *testing.T, r *recorder) Result {
	t.Helper()
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil {
		t.Fatalf("result: %v (%s)", err, r.result)
	}
	return res
}

func TestRunAnalyze(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))
	s := installSeams(t, media.Info{})
	var r recorder
	o := DefaultOptions()
	if err := m.Run(context.Background(), newJob(t, dir, "j1", o, song, &r)); err != nil {
		t.Fatal(err)
	}
	res := decodeResult(t, &r)
	if res.Action != ActionAnalyze || res.Analysis == nil || res.Analysis.Key != "kk-s1-none-m0" {
		t.Errorf("result %+v", res)
	}
	if !s.analyzed.Stems {
		t.Error("options not passed to the analyzer")
	}
}

func TestRunRenderFull(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "My Song.mp3"))
	img := writeFile(t, filepath.Join(dir, "in", "bg.png"))
	inst := writeFile(t, filepath.Join(dir, "inst.flac"))
	putAnalysis(t, m, dir, "k1-s1-none-m0", inst)
	s := installSeams(t, media.Info{DurationMs: 60_000, HasCover: true})
	clock := time.Unix(1000, 0)
	nowFn = func() time.Time { t := clock; clock = clock.Add(5 * time.Second); return t } // 5 s per call

	o := renderOpts("k1-s1-none-m0")
	o.Aspect, o.Height, o.FPS = "9:16", 720, 60
	o.Audio = "instrumental"
	o.Background = "image"
	o.BackgroundPath = img
	o.Seed = 7
	var r recorder
	job := newJob(t, dir, "j2", o, song, &r)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if s.plan.Width != 720 || s.plan.Height != 1280 || s.plan.FPS != 60 || s.plan.Mode != viz.ModeOpaque ||
		s.plan.ImagePath != img || s.plan.Seed != 7 || s.plan.StartMs != 0 || s.plan.EndMs != 60_000 || s.plan.CoverPath != "" {
		t.Errorf("plan %+v", s.plan)
	}
	if s.muxAudio != inst || s.compBase != "" {
		t.Errorf("mux audio %q, composite base %q", s.muxAudio, s.compBase)
	}
	res := decodeResult(t, &r)
	want := filepath.Join(job.OutputDir, "My Song (visualizer).mp4")
	if len(res.Outputs) != 1 || res.Outputs[0] != want || len(r.outputs) != 1 {
		t.Errorf("outputs %v / %v", res.Outputs, r.outputs)
	}
	if _, err := os.Stat(want); err != nil {
		t.Error("output file missing")
	}
	if res.Encoder != "h264-sw" || res.Speed <= 0 {
		t.Errorf("encoder/speed %+v", res)
	}
	if !strings.HasPrefix(r.title, "Rendering visuals — ") {
		t.Errorf("title %q", r.title)
	}

	// A second render doesn't overwrite the first.
	var r2 recorder
	if err := m.Run(context.Background(), newJob(t, dir, "j3", o, song, &r2)); err != nil {
		t.Fatal(err)
	}
	if got := decodeResult(t, &r2).Outputs[0]; got == want {
		t.Error("output name reused")
	}
}

func TestRunRenderCover(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))
	putAnalysis(t, m, dir, "k1-s0-none-m0", "")
	s := installSeams(t, media.Info{DurationMs: 60_000, HasCover: true})
	o := renderOpts("k1-s0-none-m0")
	o.Background = "cover"
	var r recorder
	job := newJob(t, dir, "j4", o, song, &r)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if s.plan.CoverPath != filepath.Join(job.TempDir, "cover.png") {
		t.Errorf("cover %q", s.plan.CoverPath)
	}
}

func TestRunPreview(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))
	putAnalysis(t, m, dir, "k1-s0-none-m0", "")
	s := installSeams(t, media.Info{DurationMs: 90_000})
	o := renderOpts("k1-s0-none-m0")
	o.Action = ActionPreview
	o.Height = 2160
	o.FPS = 60
	o.PreviewStartMs = 30_000
	o.StartMs, o.EndMs = 1000, 2000 // a preview ignores the render range
	var r recorder
	if err := m.Run(context.Background(), newJob(t, dir, "pj", o, song, &r)); err != nil {
		t.Fatal(err)
	}
	if s.plan.Width != 1920 || s.plan.Height != 1080 || s.plan.StartMs != 30_000 || s.plan.EndMs != 40_000 {
		t.Errorf("plan %+v", s.plan)
	}
	if s.muxFrom != 30_000 || s.muxTo != 40_000 {
		t.Errorf("mux range %d..%d", s.muxFrom, s.muxTo)
	}
	res := decodeResult(t, &r)
	want := filepath.Join(m.previewDir, "preview-pj.mp4")
	if res.PreviewPath != want || len(res.Outputs) != 0 || len(r.outputs) != 0 {
		t.Errorf("result %+v outputs %v", res, r.outputs)
	}
	if _, err := os.Stat(want); err != nil {
		t.Error("preview missing")
	}
}

func TestRunOverlay(t *testing.T) {
	m, dir := newTestModule(t)
	clip := writeFile(t, filepath.Join(dir, "in", "clip.mp4"))
	inst := writeFile(t, filepath.Join(dir, "inst.flac"))
	putAnalysis(t, m, dir, "k1-s1-none-m0", inst)
	info := media.Info{DurationMs: 60_000, Video: &media.VideoStream{Width: 3840, Height: 2160, FPS: 29.97}}
	s := installSeams(t, info)

	o := renderOpts("k1-s1-none-m0")
	o.Mode = ModeOverlay
	var r recorder
	if err := m.Run(context.Background(), newJob(t, dir, "o1", o, clip, &r)); err != nil {
		t.Fatal(err)
	}
	if s.plan.Mode != viz.ModeOverlay || s.plan.Width != 2560 || s.plan.Height != 1440 || s.plan.FPS != 30 {
		t.Errorf("plan %+v", s.plan)
	}
	if s.compBase != clip || s.compAudio != "" || s.compLoop || s.compW != 3840 || s.compH != 2160 {
		t.Errorf("composite base=%q audio=%q loop=%v %dx%d", s.compBase, s.compAudio, s.compLoop, s.compW, s.compH)
	}
	if s.cutVideo != 0 || s.cutAudio != 0 {
		t.Error("whole-range render was cut")
	}

	// A partial range with the instrumental cuts the base and the audio.
	o.StartMs, o.EndMs, o.Audio = 5_000, 15_000, "instrumental"
	var r2 recorder
	job := newJob(t, dir, "o2", o, clip, &r2)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if s.cutVideo != 1 || s.cutAudio != 1 || s.compBase != filepath.Join(job.TempDir, "base-cut.mp4") ||
		s.compAudio != filepath.Join(job.TempDir, "audio-cut.flac") {
		t.Errorf("cuts %d/%d base=%q audio=%q", s.cutVideo, s.cutAudio, s.compBase, s.compAudio)
	}
	if s.plan.StartMs != 5_000 || s.plan.EndMs != 15_000 {
		t.Errorf("plan range %d..%d", s.plan.StartMs, s.plan.EndMs)
	}

	// An overlay preview is capped at 1080p; the file input has no video -> error elsewhere.
	o.Action, o.StartMs, o.EndMs = ActionPreview, 0, 0
	var r3 recorder
	if err := m.Run(context.Background(), newJob(t, dir, "o3", o, clip, &r3)); err != nil {
		t.Fatal(err)
	}
	if s.compW != 1920 || s.compH != 1080 || s.plan.Height != 1080 {
		t.Errorf("preview size %dx%d plan %dx%d", s.compW, s.compH, s.plan.Width, s.plan.Height)
	}
}

func TestRunVideoBackground(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))
	bg := writeFile(t, filepath.Join(dir, "in", "bg.mp4"))
	putAnalysis(t, m, dir, "k1-s0-none-m0", "")
	s := installSeams(t, media.Info{DurationMs: 60_000})
	o := renderOpts("k1-s0-none-m0")
	o.Background, o.BackgroundPath = "video", bg
	o.StartMs, o.EndMs = 10_000, 20_000
	var r recorder
	if err := m.Run(context.Background(), newJob(t, dir, "v1", o, song, &r)); err != nil {
		t.Fatal(err)
	}
	if s.plan.Mode != viz.ModeOverlay || s.compBase != bg || !s.compLoop || s.compW != 1920 || s.compH != 1080 {
		t.Errorf("plan %v base %q loop %v %dx%d", s.plan.Mode, s.compBase, s.compLoop, s.compW, s.compH)
	}
	if s.cutAudio != 1 || s.cutVideo != 0 || s.compAudio == song {
		t.Errorf("audio is cut for the range, the looped video is not: %d/%d %q", s.cutAudio, s.cutVideo, s.compAudio)
	}
}

func TestRunErrors(t *testing.T) {
	m, dir := newTestModule(t)
	song := writeFile(t, filepath.Join(dir, "in", "song.mp3"))
	putAnalysis(t, m, dir, "k1-s0-none-m0", "")
	installSeams(t, media.Info{DurationMs: 60_000})

	// Range past the end of the media.
	o := renderOpts("k1-s0-none-m0")
	o.StartMs = 70_000
	var r recorder
	if err := m.Run(context.Background(), newJob(t, dir, "e1", o, song, &r)); err == nil {
		t.Error("range past the end was accepted")
	}

	// Cancellation during the render is surfaced as a cancellation.
	ctx, cancel := context.WithCancel(context.Background())
	renderFn = func(context.Context, *viz.RenderBroker, *core.JobContext, viz.RenderPlan) (viz.RenderOutput, error) {
		cancel()
		return viz.RenderOutput{}, context.Canceled
	}
	err := m.Run(ctx, newJob(t, dir, "e2", renderOpts("k1-s0-none-m0"), song, &r))
	if err == nil || ctx.Err() == nil {
		t.Errorf("err = %v", err)
	}
	if len(r.outputs) != 0 {
		t.Error("an output was registered")
	}
}

func TestPrunePreviews(t *testing.T) {
	m, _ := newTestModule(t)
	now := time.Now()
	old := writeFile(t, filepath.Join(m.previewDir, "preview-old.mp4"))
	young := writeFile(t, filepath.Join(m.previewDir, "preview-young.mp4"))
	other := writeFile(t, filepath.Join(m.previewDir, "keep.txt"))
	for p, age := range map[string]time.Duration{old: 25 * time.Hour, young: time.Hour, other: 48 * time.Hour} {
		if err := os.Chtimes(p, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	m.PrunePreviews()
	for p, want := range map[string]bool{old: false, young: true, other: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists=%v, want %v", filepath.Base(p), err == nil, want)
		}
	}
	(&Module{}).PrunePreviews() // no folder configured: no-op
}
