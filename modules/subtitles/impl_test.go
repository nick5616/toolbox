package subtitles

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

type fakeCaller struct {
	method string
	params map[string]any
	events []sidecar.Event
	result string
	err    error
	// onCall runs before returning, to create the files the engine would.
	onCall func(params map[string]any)
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.method = method
	f.params, _ = params.(map[string]any)
	for _, ev := range f.events {
		onEvent(ev)
	}
	if f.onCall != nil {
		f.onCall(f.params)
	}
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.result), nil
}

type recorder struct {
	pcts    []float64
	logs    []string
	outputs []string
	result  json.RawMessage
	toolErr error
}

func newJob(t *testing.T, r *recorder, input string, o Options) *core.JobContext {
	t.Helper()
	raw, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "Subtitles"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(p float64, _ string) { r.pcts = append(r.pcts, p) },
		Log:      func(_ core.LogStream, l string) { r.logs = append(r.logs, l) },
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) {
			if r.toolErr != nil {
				return "", r.toolErr
			}
			return id, nil
		},
		Result: func(b json.RawMessage) { r.result = b },
	})
}

func (r *recorder) res(t *testing.T) Result {
	t.Helper()
	var out Result
	if err := json.Unmarshal(r.result, &out); err != nil {
		t.Fatalf("result %s: %v", r.result, err)
	}
	return out
}

func writeFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func opts(mod func(*Options)) Options {
	o := DefaultOptions()
	mod(&o)
	return o
}

func TestValidateOptions(t *testing.T) {
	ok := []Cue{{0, 1000, "a"}, {1000, 2000, "b"}}
	tests := []struct {
		name    string
		o       Options
		wantErr string // field name, "" = valid
	}{
		{"generate default", DefaultOptions(), ""},
		{"generate bad model", opts(func(o *Options) { o.Model = "huge" }), "model"},
		{"generate bad language", opts(func(o *Options) { o.Language = "xx" }), "language"},
		{"generate line chars low", opts(func(o *Options) { o.MaxLineChars = 20 }), "maxLineChars"},
		{"generate lines", opts(func(o *Options) { o.MaxLines = 3 }), "maxLines"},
		{"extract", opts(func(o *Options) { o.Action = ActionExtract; o.StreamIndex = 2 }), ""},
		{"extract negative", opts(func(o *Options) { o.Action = ActionExtract; o.StreamIndex = -1 }), "streamIndex"},
		{"save ok", opts(func(o *Options) { o.Action = ActionSave; o.Cues = ok; o.Formats = []string{"srt", "vtt"} }), ""},
		{"save no formats", opts(func(o *Options) { o.Action = ActionSave; o.Cues = ok; o.Formats = nil }), "formats"},
		{"save dup format", opts(func(o *Options) { o.Action = ActionSave; o.Cues = ok; o.Formats = []string{"srt", "srt"} }), "formats"},
		{"save no cues", opts(func(o *Options) { o.Action = ActionSave }), "cues"},
		{"save bad order", opts(func(o *Options) { o.Action = ActionSave; o.Cues = []Cue{{1000, 2000, "a"}, {0, 500, "b"}} }), "cues"},
		{"save end before start", opts(func(o *Options) { o.Action = ActionSave; o.Cues = []Cue{{1000, 1000, "a"}} }), "cues"},
		{"save long text", opts(func(o *Options) {
			o.Action = ActionSave
			o.Cues = []Cue{{0, 1000, strings.Repeat("x", 501)}}
		}), "cues"},
		{"save too many", opts(func(o *Options) { o.Action = ActionSave; o.Cues = make([]Cue, 20001) }), "cues"},
		{"translate ok", opts(func(o *Options) { o.Action = ActionTranslate; o.Cues = ok; o.TargetLanguage = "es" }), ""},
		{"translate no target", opts(func(o *Options) { o.Action = ActionTranslate; o.Cues = ok }), "targetLanguage"},
		{"translate same", opts(func(o *Options) {
			o.Action = ActionTranslate
			o.Cues = ok
			o.TargetLanguage = "es"
			o.SourceLanguage = "es"
		}), "targetLanguage"},
		{"burn ok", opts(func(o *Options) { o.Action = ActionBurn; o.Cues = ok }), ""},
		{"burn bad font", opts(func(o *Options) { o.Action = ActionBurn; o.Cues = ok; o.Font = "Comic Sans" }), "font"},
		{"burn bad style", opts(func(o *Options) { o.Action = ActionBurn; o.Cues = ok; o.Style = "neon" }), "style"},
		{"burn bad size", opts(func(o *Options) { o.Action = ActionBurn; o.Cues = ok; o.Size = "xl" }), "size"},
		{"embed ok", opts(func(o *Options) { o.Action = ActionEmbed; o.Cues = ok; o.TrackLanguage = "fr" }), ""},
		{"embed bad language", opts(func(o *Options) { o.Action = ActionEmbed; o.Cues = ok; o.TrackLanguage = "zz" }), "trackLanguage"},
		{"unknown action", opts(func(o *Options) { o.Action = "dance" }), "action"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateOptions(tt.o)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation || ae.Fields[tt.wantErr] == "" {
				t.Fatalf("want validation error on %q, got %v", tt.wantErr, err)
			}
		})
	}
}

func TestValidateInputs(t *testing.T) {
	dir := t.TempDir()
	vid := writeFile(t, dir, "a.mp4", "x")
	srt := writeFile(t, dir, "a.srt", "x")
	m := &Module{}
	raw := func(o Options) json.RawMessage { b, _ := json.Marshal(o); return b }
	save := opts(func(o *Options) { o.Action = ActionSave; o.Cues = []Cue{{0, 1000, "a"}}; o.Formats = []string{"srt"} })
	if err := m.Validate([]string{srt}, raw(save)); err != nil {
		t.Errorf("save on srt: %v", err)
	}
	if err := m.Validate([]string{vid}, raw(save)); err != nil {
		t.Errorf("save on video: %v", err)
	}
	if err := m.Validate([]string{srt}, raw(DefaultOptions())); err == nil {
		t.Error("generate must reject a subtitle file")
	}
	if err := m.Validate(nil, raw(save)); err == nil {
		t.Error("no inputs must fail")
	}
	if err := m.Validate([]string{vid, vid}, raw(save)); err == nil {
		t.Error("two inputs must fail")
	}
	if err := m.Validate([]string{filepath.Join(dir, "missing.mp4")}, raw(save)); err == nil {
		t.Error("missing file must fail")
	}
	if err := m.Validate([]string{vid}, json.RawMessage(`{"action":"save","bogus":1}`)); err == nil {
		t.Error("unknown option fields must fail")
	}
}

func TestCheckStreams(t *testing.T) {
	withVideo := media.Info{Video: &media.VideoStream{Width: 10, Height: 10}, Subtitles: []media.SubtitleStream{{Index: 3, Text: true}, {Index: 4, Text: false}}}
	audioOnly := media.Info{}
	if err := checkStreams(Options{Action: ActionBurn}, withVideo); err != nil {
		t.Error(err)
	}
	if err := checkStreams(Options{Action: ActionBurn}, audioOnly); err == nil {
		t.Error("burn needs video")
	}
	if err := checkStreams(Options{Action: ActionEmbed}, audioOnly); err == nil {
		t.Error("embed needs video")
	}
	if err := checkStreams(Options{Action: ActionExtract, StreamIndex: 3}, withVideo); err != nil {
		t.Error(err)
	}
	if err := checkStreams(Options{Action: ActionExtract, StreamIndex: 4}, withVideo); err == nil {
		t.Error("image subtitles must be rejected")
	}
	if err := checkStreams(Options{Action: ActionExtract, StreamIndex: 9}, withVideo); err == nil {
		t.Error("missing stream must be rejected")
	}
}

func TestCanOverwrite(t *testing.T) {
	out := filepath.Join(t.TempDir(), "Subtitles")
	other := t.TempDir()
	for _, d := range []string{out, other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		path string
		want bool
	}{
		{filepath.Join(out, "a.srt"), true},
		{filepath.Join(out, "a.VTT"), true},
		{filepath.Join(out, "a.mp4"), false},
		{filepath.Join(other, "a.srt"), false},
		{filepath.Join(out, "sub", "a.srt"), false},
	}
	for _, tt := range tests {
		if got := canOverwrite(tt.path, out); got != tt.want {
			t.Errorf("canOverwrite(%s) = %v", tt.path, got)
		}
	}
}

func TestRunSave(t *testing.T) {
	cues := []Cue{{0, 1000, "one"}, {1500, 2500, "two"}}
	t.Run("new files get unique names", func(t *testing.T) {
		r := &recorder{}
		in := writeFile(t, t.TempDir(), "talk.mp4", "x")
		job := newJob(t, r, in, opts(func(o *Options) { o.Action = ActionSave; o.Cues = cues; o.Formats = []string{"srt", "vtt"} }))
		if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
			t.Fatal(err)
		}
		writeFile(t, job.OutputDir, "talk.srt", "existing")
		m := &Module{}
		if err := m.Run(context.Background(), job); err != nil {
			t.Fatal(err)
		}
		if len(r.outputs) != 2 || filepath.Base(r.outputs[0]) != "talk (1).srt" || filepath.Base(r.outputs[1]) != "talk.vtt" {
			t.Errorf("outputs %v", r.outputs)
		}
		if b, _ := os.ReadFile(filepath.Join(job.OutputDir, "talk.srt")); string(b) != "existing" {
			t.Error("existing file was modified")
		}
		if res := r.res(t); res.Cues != 2 || len(res.Outputs) != 2 {
			t.Errorf("result %+v", res)
		}
	})
	t.Run("own srt is overwritten", func(t *testing.T) {
		r := &recorder{}
		job := newJob(t, r, "", opts(func(o *Options) { o.Action = ActionSave; o.Cues = cues; o.Formats = []string{"srt"} }))
		if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
			t.Fatal(err)
		}
		own := writeFile(t, job.OutputDir, "talk.srt", "old")
		job.Inputs = []string{own}
		if err := (&Module{}).Run(context.Background(), job); err != nil {
			t.Fatal(err)
		}
		if len(r.outputs) != 1 || r.outputs[0] != own {
			t.Errorf("outputs %v", r.outputs)
		}
		if b, _ := os.ReadFile(own); string(b) != formatSRT(cues) {
			t.Errorf("not overwritten: %q", b)
		}
	})
	t.Run("foreign srt is never modified", func(t *testing.T) {
		r := &recorder{}
		foreign := writeFile(t, t.TempDir(), "mine.srt", "precious")
		job := newJob(t, r, foreign, opts(func(o *Options) { o.Action = ActionSave; o.Cues = cues; o.Formats = []string{"srt"} }))
		if err := (&Module{}).Run(context.Background(), job); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(foreign); string(b) != "precious" {
			t.Error("foreign file modified")
		}
		if len(r.outputs) != 1 || filepath.Dir(r.outputs[0]) != job.OutputDir {
			t.Errorf("outputs %v", r.outputs)
		}
	})
}

const engineJSON = `{"language":"en","duration":6,"segments":[
 {"start":0.0,"end":3.0,"text":"Hello there my friend. How are you?","words":[
  {"start":0.0,"end":0.4,"word":" Hello"},{"start":0.5,"end":0.8,"word":" there"},{"start":0.9,"end":1.1,"word":" my"},
  {"start":1.2,"end":1.6,"word":" friend."},{"start":2.0,"end":2.2,"word":" How"},{"start":2.3,"end":2.5,"word":" are"},{"start":2.6,"end":2.9,"word":" you?"}]}]}`

func TestRunGenerate(t *testing.T) {
	r := &recorder{}
	in := writeFile(t, t.TempDir(), "clip.mp4", "x")
	o := opts(func(o *Options) { o.Formats = []string{"srt", "vtt"}; o.Language = "en"; o.TranslateToEnglish = true })
	job := newJob(t, r, in, o)
	fc := &fakeCaller{
		result: `{"language":"en","outputs":[]}`,
		events: []sidecar.Event{{Kind: "progress", Pct: 0.5, Msg: "x"}, {Kind: "output", Path: "/tmp/ignored"}, {Kind: "log", Line: "hi", Level: "info"}},
		onCall: func(p map[string]any) {
			writeFile(t, p["outputDir"].(string), p["baseName"].(string)+".json", engineJSON)
		},
	}
	m := &Module{sc: fc, modelsDir: "models"}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if fc.method != "transcribe.run" {
		t.Errorf("method %q", fc.method)
	}
	if fc.params["task"] != "translate" || fc.params["language"] != "en" || fc.params["vad"] != true {
		t.Errorf("params %+v", fc.params)
	}
	if f, _ := fc.params["formats"].([]string); len(f) != 1 || f[0] != "json" {
		t.Errorf("formats %v", fc.params["formats"])
	}
	if fc.params["outputDir"] != job.TempDir {
		t.Error("transcript must go to TempDir")
	}
	if len(r.outputs) != 2 || !strings.HasSuffix(r.outputs[0], "clip.srt") || !strings.HasSuffix(r.outputs[1], "clip.vtt") {
		t.Fatalf("outputs %v", r.outputs)
	}
	for _, p := range r.outputs {
		if filepath.Dir(p) != job.OutputDir {
			t.Errorf("output outside the output dir: %s", p)
		}
	}
	cues, err := load(r.outputs[0])
	if err != nil || len(cues) != 2 {
		t.Fatalf("cues %+v err %v", cues, err)
	}
	checkLimits(t, cues, 42, 2)
	if res := r.res(t); res.Language != "en" || res.Cues != 2 || res.Action != ActionGenerate {
		t.Errorf("result %+v", res)
	}
	for _, p := range r.pcts {
		if p > 0.9 && p != 1 {
			t.Errorf("progress %v exceeds the engine band", p)
		}
	}
}

func TestRunGenerateErrors(t *testing.T) {
	in := writeFile(t, t.TempDir(), "clip.mp4", "x")
	t.Run("engine missing", func(t *testing.T) {
		r := &recorder{toolErr: core.ErrDependencyMissing("audio-engine", "install it")}
		err := (&Module{sc: &fakeCaller{}}).Run(context.Background(), newJob(t, r, in, DefaultOptions()))
		var ae *core.AppError
		if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
			t.Errorf("err %v", err)
		}
	})
	t.Run("engine error passes through", func(t *testing.T) {
		boom := core.Errorf(core.CodeToolFailed, "boom")
		err := (&Module{sc: &fakeCaller{err: boom}}).Run(context.Background(), newJob(t, &recorder{}, in, DefaultOptions()))
		if !errors.Is(err, boom) {
			t.Errorf("err %v", err)
		}
	})
	t.Run("silence", func(t *testing.T) {
		r := &recorder{}
		fc := &fakeCaller{result: `{"language":"en"}`, onCall: func(p map[string]any) {
			writeFile(t, p["outputDir"].(string), "transcript.json", `{"language":"en","segments":[]}`)
		}}
		if err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, in, DefaultOptions())); err != nil {
			t.Fatal(err)
		}
		if len(r.outputs) != 0 || r.res(t).Cues != 0 {
			t.Errorf("outputs %v", r.outputs)
		}
	})
}

func TestRunTranslate(t *testing.T) {
	cues := []Cue{{0, 1000, "hello"}, {1500, 2500, "bye"}}
	in := writeFile(t, t.TempDir(), "talk.srt", "x")
	o := opts(func(o *Options) {
		o.Action = ActionTranslate
		o.Cues = cues
		o.TargetLanguage = "es"
		o.SourceLanguage = "en"
	})
	t.Run("ok", func(t *testing.T) {
		r := &recorder{}
		tg := &fakeTG{reply: echoUpper}
		job := newJob(t, r, in, o)
		if err := (&Module{tg: tg}).Run(context.Background(), job); err != nil {
			t.Fatal(err)
		}
		if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "talk.es.srt" {
			t.Fatalf("outputs %v", r.outputs)
		}
		got, err := load(r.outputs[0])
		if err != nil || len(got) != 2 || got[0].Text != "HELLO" || got[1].StartMs != 1500 || got[1].EndMs != 2500 {
			t.Errorf("got %+v err %v", got, err)
		}
		if res := r.res(t); res.Language != "es" || res.Cues != 2 {
			t.Errorf("result %+v", res)
		}
	})
	t.Run("no model fails fast", func(t *testing.T) {
		tg := &fakeTG{reply: echoUpper, readyErr: core.ErrDependencyMissing("chat model", "")}
		err := (&Module{tg: tg}).Run(context.Background(), newJob(t, &recorder{}, in, o))
		var ae *core.AppError
		if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing || ae.Hint == "" {
			t.Fatalf("err %v", err)
		}
		if len(tg.reqs) != 0 {
			t.Error("must not start a request")
		}
	})
	t.Run("status", func(t *testing.T) {
		if s := (&Module{tg: &fakeTG{}}).translatorStatus(); !s.Ready || s.Model != "fake-model" {
			t.Errorf("status %+v", s)
		}
		s := (&Module{tg: &fakeTG{readyErr: core.Errorf(core.CodeDependencyMissing, "Download a model").WithHint("Open Local Chat")}}).translatorStatus()
		if s.Ready || !strings.Contains(s.Error, "Download a model") {
			t.Errorf("status %+v", s)
		}
		if s := (&Module{}).translatorStatus(); s.Ready || s.Error == "" {
			t.Errorf("nil generator: %+v", s)
		}
	})
}

func TestLanguagesAndStyles(t *testing.T) {
	langs := translationLanguages()
	seen := map[string]bool{}
	for i, l := range langs {
		if seen[l.Code] {
			t.Errorf("duplicate %s", l.Code)
		}
		seen[l.Code] = true
		if i > 0 && langs[i-1].Name >= l.Name {
			t.Errorf("not sorted at %s", l.Name)
		}
		if _, ok := iso639_2[l.Code]; !ok {
			t.Errorf("no ISO 639-2 code for %s", l.Code)
		}
	}
	for _, c := range []string{"bn", "tl", "sw", "ta", "ur", "en", "es"} {
		if !seen[c] {
			t.Errorf("missing %s", c)
		}
	}
	if len(styles()) != 4 {
		t.Errorf("styles %v", styles())
	}
}
