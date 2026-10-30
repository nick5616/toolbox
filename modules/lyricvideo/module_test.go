package lyricvideo

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// fakeEngine plays the AI engine: stems.separate writes two FLAC stand-ins,
// transcribe.run writes the JSON document.
type fakeEngine struct {
	calls      []string
	params     map[string]map[string]any
	transcript string
	err        map[string]error
	events     []sidecar.Event
}

func (f *fakeEngine) Call(ctx context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.calls = append(f.calls, method)
	if f.params == nil {
		f.params = map[string]map[string]any{}
	}
	p := params.(map[string]any)
	f.params[method] = p
	if err := f.err[method]; err != nil {
		return nil, err
	}
	for _, ev := range f.events {
		onEvent(ev)
	}
	switch method {
	case "stems.separate":
		dir := p["outputDir"].(string)
		v, i := filepath.Join(dir, "stem - Vocals.flac"), filepath.Join(dir, "stem - Instrumental.flac")
		os.WriteFile(v, []byte("v"), 0o644)
		os.WriteFile(i, []byte("i"), 0o644)
		b, _ := json.Marshal(map[string]any{"stems": []map[string]string{{"name": "Vocals", "path": v}, {"name": "Instrumental", "path": i}}, "model": p["model"]})
		return b, nil
	case "transcribe.run":
		out := filepath.Join(p["outputDir"].(string), "lyrics.json")
		os.WriteFile(out, []byte(f.transcript), 0o644)
		b, _ := json.Marshal(map[string]any{"outputs": []string{out}})
		return b, nil
	}
	return nil, errors.New("unexpected method " + method)
}

const transcript = `{"language":"en","duration":12,"segments":[
 {"start":1.0,"end":3.0,"text":" hello darkness my old friend","words":[
  {"start":1.0,"end":1.4,"word":" hello"},{"start":1.5,"end":2.0,"word":" darkness"},{"start":2.1,"end":2.3,"word":" my"},
  {"start":2.4,"end":2.6,"word":" old"},{"start":2.7,"end":3.0,"word":" friend"}]},
 {"start":6.0,"end":8.0,"text":" i've come to talk with you","words":[
  {"start":6.0,"end":6.3,"word":" ive"},{"start":6.4,"end":6.7,"word":" come"},{"start":6.8,"end":7.0,"word":" to"},
  {"start":7.1,"end":7.4,"word":" talk"},{"start":7.5,"end":7.7,"word":" with"},{"start":7.8,"end":8.0,"word":" you"}]}]}`

type harness struct {
	m      *Module
	eng    *fakeEngine
	song   string
	job    *core.JobContext
	result json.RawMessage
	prog   []float64
	logs   []string
	outs   []string
	noTool map[string]bool
}

func newHarness(t *testing.T, o Options) *harness {
	t.Helper()
	dir := t.TempDir()
	h := &harness{eng: &fakeEngine{transcript: transcript}, noTool: map[string]bool{}}
	h.m = &Module{sc: h.eng, modelsDir: filepath.Join(dir, "models"), cacheDir: filepath.Join(dir, "cache")}
	h.song = filepath.Join(dir, "My Song.mp3")
	if err := os.WriteFile(h.song, []byte("not really audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.job = h.newJob(t, o)
	return h
}

func (h *harness) newJob(t *testing.T, o Options) *core.JobContext {
	raw, _ := json.Marshal(o)
	return core.NewJobContext(core.JobContext{
		ID: "j1", Inputs: []string{h.song}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(p float64, _ string) { h.prog = append(h.prog, p) },
		Log:      func(_ core.LogStream, l string) { h.logs = append(h.logs, l) },
		Output:   func(p string) (core.Output, error) { h.outs = append(h.outs, p); return core.Output{Path: p}, nil },
		Tool: func(id string) (string, error) {
			if h.noTool[id] {
				return "", core.ErrDependencyMissing(id, "install it")
			}
			return "/bin/" + id, nil
		},
		Result: func(r json.RawMessage) { h.result = r },
	})
}

func (h *harness) result_(t *testing.T) Result {
	t.Helper()
	var r Result
	if err := json.Unmarshal(h.result, &r); err != nil {
		t.Fatalf("result: %v (%s)", err, h.result)
	}
	return r
}

func TestValidate(t *testing.T) {
	dir := t.TempDir()
	song := filepath.Join(dir, "a.mp3")
	os.WriteFile(song, []byte("x"), 0o644)
	lrc := filepath.Join(dir, "l.lrc")
	os.WriteFile(lrc, []byte("[00:01.00]x"), 0o644)
	bad := filepath.Join(dir, "l.doc")
	os.WriteFile(bad, []byte("x"), 0o644)
	lines := []LyricLine{{StartMs: 0, EndMs: 10, Text: "a"}}

	mk := func(f func(o *Options)) Options {
		o := DefaultOptions()
		f(&o)
		return o
	}
	tests := []struct {
		name string
		o    Options
		bad  string // "" = valid, else a field that must be flagged
	}{
		{"default needs text", DefaultOptions(), "text"},
		{"align ok", mk(func(o *Options) { o.Text = "hello" }), ""},
		{"align too long", mk(func(o *Options) { o.Text = strings.Repeat("a", maxLyricsChars+1) }), "text"},
		{"detect ok", mk(func(o *Options) { o.Source = SourceDetect }), ""},
		{"file ok", mk(func(o *Options) { o.Source, o.LyricsPath = SourceFile, lrc }), ""},
		{"file missing", mk(func(o *Options) { o.Source, o.LyricsPath = SourceFile, filepath.Join(dir, "nope.lrc") }), "lyricsPath"},
		{"file type", mk(func(o *Options) { o.Source, o.LyricsPath = SourceFile, bad }), "lyricsPath"},
		{"bad source", mk(func(o *Options) { o.Source = "x" }), "source"},
		{"bad action", mk(func(o *Options) { o.Action = "x" }), "action"},
		{"render ok", mk(func(o *Options) { o.Action, o.Lines = ActionRender, lines }), ""},
		{"render no lines", mk(func(o *Options) { o.Action = ActionRender }), "lines"},
		{"preview unsorted", mk(func(o *Options) {
			o.Action, o.Lines = ActionPreview, []LyricLine{{StartMs: 5, EndMs: 6}, {StartMs: 1, EndMs: 2}}
		}), "lines.1"},
		{"bad colour", mk(func(o *Options) { o.Action, o.Lines, o.Look.TextColor = ActionRender, lines, "white" }), "look.textColor"},
		{"bad font", mk(func(o *Options) { o.Action, o.Lines, o.Look.Font = ActionRender, lines, "Comic Sans" }), "look.font"},
		{"bad aspect", mk(func(o *Options) { o.Action, o.Lines, o.Aspect = ActionRender, lines, "4:3" }), "aspect"},
		{"bad height", mk(func(o *Options) { o.Action, o.Lines, o.Height = ActionRender, lines, 480 }), "height"},
		{"bad audio", mk(func(o *Options) { o.Action, o.Lines, o.Audio = ActionRender, lines, "stems" }), "audio"},
		{"image needs path", mk(func(o *Options) { o.Action, o.Lines, o.Look.Background = ActionRender, lines, "image" }), "look.backgroundPath"},
		{"image ok", mk(func(o *Options) {
			o.Action, o.Lines, o.Look.Background, o.Look.BackgroundPath = ActionRender, lines, "image", lrc
		}), ""},
		{"negative preview start", mk(func(o *Options) { o.Action, o.Lines, o.PreviewStartMs = ActionPreview, lines, -1 }), "previewStartMs"},
		{"lrc ok", mk(func(o *Options) { o.Action, o.Lines = ActionLRC, lines }), ""},
		{"lrc no lines", mk(func(o *Options) { o.Action = ActionLRC }), "lines"},
		{"empty look fields are defaults", Options{Action: ActionRender, Lines: lines}, ""},
	}
	m := &Module{}
	for _, tc := range tests {
		raw, _ := json.Marshal(tc.o)
		err := m.Validate([]string{song}, raw)
		if tc.bad == "" {
			if err != nil {
				t.Errorf("%s: %v", tc.name, err)
			}
			continue
		}
		var ae *core.AppError
		if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
			t.Errorf("%s: err = %v", tc.name, err)
			continue
		}
		if _, ok := ae.Fields[tc.bad]; !ok {
			t.Errorf("%s: fields = %v, want %q", tc.name, ae.Fields, tc.bad)
		}
	}
	if err := m.Validate(nil, nil); err == nil {
		t.Error("no input should fail")
	}
	if err := m.Validate([]string{song}, json.RawMessage(`{"bogus":1}`)); err == nil {
		t.Error("unknown option should fail")
	}
}

func TestLyricsAlign(t *testing.T) {
	o := DefaultOptions()
	o.Source, o.Language = SourceAlign, "en"
	o.Text = "Hello darkness, my old friend\n\nI've come to talk with you again"
	h := newHarness(t, o)
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	if strings.Join(h.eng.calls, ",") != "stems.separate,transcribe.run" {
		t.Fatalf("calls = %v", h.eng.calls)
	}
	sp := h.eng.params["stems.separate"]
	if sp["model"] != stemsModel || sp["outputFormat"] != "flac" || !strings.HasPrefix(sp["outputDir"].(string), h.m.cacheDir) {
		t.Errorf("stems params = %v", sp)
	}
	tp := h.eng.params["transcribe.run"]
	if tp["input"] != filepath.Join(sp["outputDir"].(string), vocalsName) || tp["language"] != "en" || tp["vad"] != true ||
		tp["modelDir"] != filepath.Join(h.m.modelsDir, "whisper", "small") || tp["model"] != whisperRepo {
		t.Errorf("transcribe params = %v", tp)
	}
	if f, ok := tp["formats"].([]string); !ok || len(f) != 1 || f[0] != "json" {
		t.Errorf("formats = %v", tp["formats"])
	}
	r := h.result_(t)
	if r.Action != ActionLyrics || len(r.Lines) != 2 || !r.HasInstrumental {
		t.Fatalf("result = %+v", r)
	}
	// 10 of 11 lyric tokens ("again" was never recognised).
	if r.Matched < 0.9 || r.Matched > 0.92 {
		t.Errorf("matched = %v", r.Matched)
	}
	if r.Lines[0].StartMs != 1000 || r.Lines[1].StartMs != 6000 {
		t.Errorf("line starts = %d, %d", r.Lines[0].StartMs, r.Lines[1].StartMs)
	}
	// The unmatched trailing word follows "you".
	last := r.Lines[1].Words[len(r.Lines[1].Words)-1]
	if last.Text != "again" || last.StartMs != 8000 || last.EndMs != 8300 {
		t.Errorf("again = %+v", last)
	}
	if len(h.outs) != 0 {
		t.Errorf("the lyrics action must not register outputs: %v", h.outs)
	}
	// Progress stays in 0..1 and reaches the end.
	for _, p := range h.prog {
		if p > 1 || p < -1 {
			t.Errorf("progress %v", p)
		}
	}
	if h.prog[len(h.prog)-1] != 1 {
		t.Errorf("last progress = %v", h.prog[len(h.prog)-1])
	}
	if _, err := os.Stat(filepath.Join(sp["outputDir"].(string), instrumentalName)); err != nil {
		t.Errorf("instrumental not cached: %v", err)
	}

	// A second run reuses the cached stems.
	h2 := h
	h2.eng.calls = nil
	job := h.newJob(t, o)
	if err := h.m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if strings.Join(h2.eng.calls, ",") != "transcribe.run" {
		t.Errorf("second run calls = %v", h2.eng.calls)
	}
}

func TestLyricsDetect(t *testing.T) {
	o := DefaultOptions()
	o.Source = SourceDetect
	h := newHarness(t, o)
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	r := h.result_(t)
	if len(r.Lines) != 2 || r.Lines[0].Text != "hello darkness my old friend" || r.Lines[1].Text != "ive come to talk with you" {
		t.Fatalf("lines = %+v", r.Lines)
	}
	if h.eng.params["transcribe.run"]["language"] != nil {
		t.Errorf("language = %v, want auto (nil)", h.eng.params["transcribe.run"]["language"])
	}
	// No words recognised: an error with a hint.
	h = newHarness(t, o)
	h.eng.transcript = `{"language":"en","duration":3,"segments":[]}`
	err := h.m.Run(context.Background(), h.job)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeToolFailed || ae.Hint == "" {
		t.Errorf("err = %v", err)
	}
}

func TestLyricsFile(t *testing.T) {
	dir := t.TempDir()
	lrc := filepath.Join(dir, "l.lrc")
	os.WriteFile(lrc, []byte("[00:01.00]First\n[00:03.00]Second\n"), 0o644)
	o := DefaultOptions()
	o.Source, o.LyricsPath = SourceFile, lrc
	h := newHarness(t, o)
	h.noTool[sidecar.DepID] = true // an LRC needs no engine
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	r := h.result_(t)
	if len(h.eng.calls) != 0 || len(r.Lines) != 2 || r.Lines[0].Text != "First" || r.Matched != 1 {
		t.Fatalf("calls %v, result %+v", h.eng.calls, r)
	}

	srt := filepath.Join(dir, "l.srt")
	os.WriteFile(srt, []byte("1\n00:00:02,000 --> 00:00:04,000\nHi there\n"), 0o644)
	o.LyricsPath = srt
	h = newHarness(t, o)
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	if r := h.result_(t); len(r.Lines) != 1 || r.Lines[0].StartMs != 2000 || len(r.Lines[0].Words) != 2 {
		t.Errorf("srt result %+v", r)
	}

	// A TXT file is aligned, which needs the engine.
	txt := filepath.Join(dir, "l.txt")
	os.WriteFile(txt, []byte("hello darkness my old friend\n"), 0o644)
	o.LyricsPath = txt
	h = newHarness(t, o)
	h.noTool[sidecar.DepID] = true
	err := h.m.Run(context.Background(), h.job)
	if !core.IsCode(err, core.CodeDependencyMissing) {
		t.Fatalf("txt without engine: %v", err)
	}
	h = newHarness(t, o)
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	if r := h.result_(t); len(r.Lines) != 1 || r.Lines[0].StartMs != 1000 {
		t.Errorf("txt result %+v", r)
	}

	// An LRC with no usable lines is an error.
	empty := filepath.Join(dir, "e.lrc")
	os.WriteFile(empty, []byte("[ti:x]\n"), 0o644)
	o.LyricsPath = empty
	h = newHarness(t, o)
	if err := h.m.Run(context.Background(), h.job); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("empty lrc: %v", err)
	}
}

func TestEngineMissingAndErrors(t *testing.T) {
	o := DefaultOptions()
	o.Text = "hello"
	h := newHarness(t, o)
	h.noTool[sidecar.DepID] = true
	if err := h.m.Run(context.Background(), h.job); !core.IsCode(err, core.CodeDependencyMissing) {
		t.Errorf("err = %v", err)
	}
	if len(h.eng.calls) != 0 {
		t.Errorf("calls = %v", h.eng.calls)
	}

	h = newHarness(t, o)
	h.eng.err = map[string]error{"transcribe.run": core.Errorf(core.CodeToolFailed, "boom")}
	if err := h.m.Run(context.Background(), h.job); !core.IsCode(err, core.CodeToolFailed) {
		t.Errorf("err = %v", err)
	}

	// Cancellation passes through.
	h = newHarness(t, o)
	h.eng.err = map[string]error{"stems.separate": context.Canceled}
	if err := h.m.Run(context.Background(), h.job); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
}

func TestEngineEventsMapToJob(t *testing.T) {
	o := DefaultOptions()
	o.Text = "hello"
	h := newHarness(t, o)
	h.eng.events = []sidecar.Event{{Kind: "progress", Pct: 0.5, Msg: "x"}, {Kind: "log", Line: "hello", Level: "info"}}
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	// 0.5 of stems scoped to 0..0.5 is 0.25; 0.5 of transcribe scoped to 0.5..0.95 is 0.725.
	var saw25, saw725 bool
	for _, p := range h.prog {
		saw25 = saw25 || (p > 0.249 && p < 0.251)
		saw725 = saw725 || (p > 0.724 && p < 0.726)
	}
	if !saw25 || !saw725 || len(h.logs) < 2 {
		t.Errorf("progress %v logs %v", h.prog, h.logs)
	}
}

func TestLRCAction(t *testing.T) {
	o := DefaultOptions()
	o.Action = ActionLRC
	o.Lines = []LyricLine{{StartMs: 1000, EndMs: 2000, Text: "Hi there", Words: []LyricWord{{StartMs: 1000, EndMs: 1500, Text: "Hi"}, {StartMs: 1500, EndMs: 2000, Text: "there"}}}}
	o.Look.Title = "Title"
	h := newHarness(t, o)
	h.noTool[sidecar.DepID] = true
	h.noTool["ffmpeg"] = true // the action needs neither
	if err := os.MkdirAll(h.job.OutputDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	r := h.result_(t)
	if len(r.Outputs) != 1 || filepath.Base(r.Outputs[0]) != "My Song.lrc" || len(h.outs) != 1 {
		t.Fatalf("result %+v outs %v", r, h.outs)
	}
	data, _ := os.ReadFile(r.Outputs[0])
	if string(data) != "[ti:Title]\n[00:01.00]<00:01.00>Hi <00:01.50>there\n" {
		t.Errorf("lrc = %q", data)
	}
}

func TestPruneCache(t *testing.T) {
	h := newHarness(t, DefaultOptions())
	old := time.Now().Add(-8 * 24 * time.Hour)
	fresh := time.Now().Add(-2 * 24 * time.Hour)
	mk := func(name string, dir bool, at time.Time) string {
		p := filepath.Join(h.m.cacheDir, name)
		if dir {
			os.MkdirAll(p, 0o755)
		} else {
			os.MkdirAll(h.m.cacheDir, 0o755)
			os.WriteFile(p, []byte("x"), 0o644)
		}
		os.Chtimes(p, at, at)
		return p
	}
	oldDir, freshDir := mk("aaa", true, old), mk("bbb", true, fresh)
	oldPrev, freshPrev := mk("preview-1.mp4", false, time.Now().Add(-48*time.Hour)), mk("preview-2.mp4", false, time.Now())
	other := mk("keep.txt", false, old)
	h.m.PruneCache()
	for p, want := range map[string]bool{oldDir: false, freshDir: true, oldPrev: false, freshPrev: true, other: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists = %v, want %v", filepath.Base(p), err == nil, want)
		}
	}
	(&Module{}).PruneCache() // no cache dir: a no-op
}

func TestStemsCacheKeyTracksTheFile(t *testing.T) {
	h := newHarness(t, DefaultOptions())
	a, _ := h.m.stemsDir(h.song)
	b, _ := h.m.stemsDir(h.song)
	if a != b || filepath.Dir(a) != h.m.cacheDir || len(filepath.Base(a)) != 40 {
		t.Errorf("dirs %s %s", a, b)
	}
	os.WriteFile(h.song, []byte("changed content"), 0o644)
	if c, _ := h.m.stemsDir(h.song); c == a {
		t.Error("the key should change with the file")
	}
	if _, err := h.m.stemsDir(filepath.Join(t.TempDir(), "missing.mp3")); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("missing: %v", err)
	}
}
