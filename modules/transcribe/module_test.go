package transcribe

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
)

type fakeCaller struct {
	calls  int
	method string
	params any
	events []sidecar.Event
	result string
	err    error
	block  bool
}

func (f *fakeCaller) Call(ctx context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.calls++
	f.method, f.params = method, params
	for _, ev := range f.events {
		onEvent(ev)
	}
	if f.block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.result), nil
}

type rec struct {
	title    string
	progress []string
	pcts     []float64
	logs     []string
	outputs  []string
	result   json.RawMessage
	toolErr  error
}

func (r *rec) hooks() core.JobHooks {
	return core.JobHooks{
		Progress: func(p float64, m string) { r.pcts = append(r.pcts, p); r.progress = append(r.progress, m) },
		Log:      func(s core.LogStream, l string) { r.logs = append(r.logs, string(s)+":"+l) },
		Title:    func(t string) { r.title = t },
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool:   func(string) (string, error) { return "/engine", r.toolErr },
		Result: func(b json.RawMessage) { r.result = b },
	}
}

func newJob(t *testing.T, r *rec, input, opts string) *core.JobContext {
	t.Helper()
	return core.NewJobContext(core.JobContext{Inputs: []string{input}, Options: json.RawMessage(opts), OutputDir: t.TempDir()}, r.hooks())
}

func touch(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const goodOpts = `{"model":"small","language":"","task":"transcribe","formats":["txt","srt"],"vad":true}`

func TestValidate(t *testing.T) {
	good := touch(t, "a.mp3")
	bad := touch(t, "a.txt")
	m := &Module{}
	tests := []struct {
		name   string
		inputs []string
		opts   string
		field  string // "" = ok, "-" = any validation error
	}{
		{"ok", []string{good}, goodOpts, ""},
		{"ok language", []string{good}, `{"model":"turbo","language":"de","task":"translate","formats":["json","vtt"],"vad":false}`, ""},
		{"no inputs", nil, goodOpts, "inputs"},
		{"bad file", []string{bad}, goodOpts, "inputs.0"},
		{"bad model", []string{good}, `{"model":"huge","language":"","task":"transcribe","formats":["txt"]}`, "model"},
		{"bad task", []string{good}, `{"model":"base","language":"","task":"x","formats":["txt"]}`, "task"},
		{"bad language", []string{good}, `{"model":"base","language":"xx","task":"transcribe","formats":["txt"]}`, "language"},
		{"no formats", []string{good}, `{"model":"base","language":"","task":"transcribe","formats":[]}`, "formats"},
		{"unknown format", []string{good}, `{"model":"base","language":"","task":"transcribe","formats":["pdf"]}`, "formats"},
		{"duplicate format", []string{good}, `{"model":"base","language":"","task":"transcribe","formats":["txt","txt"]}`, "formats"},
		{"empty options", []string{good}, `{}`, "model"},
		{"unknown field", []string{good}, `{"model":"base","x":1}`, "-"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.inputs, json.RawMessage(tc.opts))
			if tc.field == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !core.IsCode(err, core.CodeValidation) {
				t.Fatalf("want validation error, got %v", err)
			}
			if tc.field == "-" {
				return
			}
			var ae *core.AppError
			errors.As(err, &ae)
			if _, ok := ae.Fields[tc.field]; !ok {
				t.Fatalf("fields %v lack %q", ae.Fields, tc.field)
			}
		})
	}
}

func TestRunHappyPath(t *testing.T) {
	input := touch(t, "Talk.mp3")
	r := &rec{}
	job := newJob(t, r, input, `{"model":"turbo","language":"es","task":"translate","formats":["txt","json"],"vad":false}`)
	tp := filepath.Join(job.OutputDir, "Talk.txt")
	jp := filepath.Join(job.OutputDir, "Talk.json")
	b, _ := json.Marshal(map[string]any{"language": "es", "languageProbability": 0.9, "durationSec": 250.4,
		"segments": 212, "words": 900, "outputs": []string{tp, jp}})
	fc := &fakeCaller{
		events: []sidecar.Event{
			{Kind: "progress", Pct: 0.5, Msg: "Transcribing · 1:23 / 4:10"},
			{Kind: "log", Line: "info", Level: "info"},
			{Kind: "log", Line: "warn", Level: "warning"},
			{Kind: "output", Path: tp},
		},
		result: string(b),
	}
	m := &Module{sc: fc, modelsDir: "/models"}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if fc.method != "transcribe.run" {
		t.Fatalf("method %q", fc.method)
	}
	want := map[string]any{
		"input": input, "outputDir": job.OutputDir, "baseName": "Talk",
		"model": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "modelDir": filepath.Join("/models", "whisper", "turbo"),
		"language": "es", "task": "translate", "formats": []string{"txt", "json"}, "vad": false,
	}
	if !reflect.DeepEqual(fc.params, want) {
		t.Fatalf("params %v\nwant %v", fc.params, want)
	}
	if r.title != "Talk.mp3" {
		t.Fatalf("title %q", r.title)
	}
	if !reflect.DeepEqual(r.outputs, []string{tp, jp}) {
		t.Fatalf("outputs %v", r.outputs)
	}
	if !reflect.DeepEqual(r.logs, []string{"stdout:info", "stderr:warn"}) {
		t.Fatalf("logs %v", r.logs)
	}
	if r.progress[0] != "Transcribing · 1:23 / 4:10" || r.pcts[0] != 0.5 {
		t.Fatalf("progress %v", r.progress)
	}
	if last := len(r.progress) - 1; r.progress[last] != "Spanish · 4:10 · 212 segments" || r.pcts[last] != 1 {
		t.Fatalf("final progress %v", r.progress)
	}
	var got Result
	if err := json.Unmarshal(r.result, &got); err != nil {
		t.Fatal(err)
	}
	if got.Language != "es" || got.Segments != 212 || got.Words != 900 || len(got.Outputs) != 2 {
		t.Fatalf("result %s", r.result)
	}
}

func TestRunAutoLanguageNull(t *testing.T) {
	input := touch(t, "a.wav")
	fc := &fakeCaller{result: `{"language":"xx","durationSec":3725,"segments":1,"words":0,"outputs":null}`}
	r := &rec{}
	if err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, input, goodOpts)); err != nil {
		t.Fatal(err)
	}
	if lang, ok := fc.params.(map[string]any)["language"]; !ok || lang != nil {
		t.Fatalf("language %v", lang)
	}
	if last := r.progress[len(r.progress)-1]; last != "XX · 1:02:05 · 1 segment" {
		t.Fatalf("final %q", last)
	}
}

func TestSummaryHelpers(t *testing.T) {
	for sec, want := range map[float64]string{0: "0:00", 59.9: "0:59", 250.4: "4:10", 3600: "1:00:00", -5: "0:00"} {
		if got := clock(sec); got != want {
			t.Errorf("clock(%v)=%q want %q", sec, got, want)
		}
	}
	if languageName("en") != "English" || languageName("zz") != "ZZ" {
		t.Fatal("languageName")
	}
}

func TestRunErrors(t *testing.T) {
	input := touch(t, "s.wav")

	t.Run("engine missing", func(t *testing.T) {
		r := &rec{toolErr: core.ErrDependencyMissing(sidecar.DepID, "Install it")}
		fc := &fakeCaller{}
		err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, input, goodOpts))
		if err != r.toolErr || !core.IsCode(err, core.CodeDependencyMissing) || fc.calls != 0 {
			t.Fatalf("err %v calls %d", err, fc.calls)
		}
	})
	t.Run("app error passthrough", func(t *testing.T) {
		want := core.Errorf(core.CodeToolFailed, "boom").WithHint("h")
		err := (&Module{sc: &fakeCaller{err: want}}).Run(context.Background(), newJob(t, &rec{}, input, goodOpts))
		if err != want {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := (&Module{sc: &fakeCaller{block: true}}).Run(ctx, newJob(t, &rec{}, input, goodOpts))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("bad options", func(t *testing.T) {
		fc := &fakeCaller{}
		err := (&Module{sc: fc}).Run(context.Background(), newJob(t, &rec{}, input, `{"model":"zz"}`))
		if !core.IsCode(err, core.CodeValidation) || fc.calls != 0 {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("unreadable result", func(t *testing.T) {
		err := (&Module{sc: &fakeCaller{result: `nope`}}).Run(context.Background(), newJob(t, &rec{}, input, goodOpts))
		if !core.IsCode(err, core.CodeInternal) {
			t.Fatalf("got %v", err)
		}
	})
}
