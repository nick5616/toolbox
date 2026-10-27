package stems

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

func TestValidate(t *testing.T) {
	good := touch(t, "a.mp3")
	bad := touch(t, "a.txt")
	m := &Module{}
	tests := []struct {
		name   string
		inputs []string
		opts   string
		field  string
	}{
		{"ok", []string{good}, `{"preset":"four-fast","format":"wav"}`, ""},
		{"ok flac best", []string{good}, `{"preset":"vocals-best","format":"flac"}`, ""},
		{"no inputs", nil, `{"preset":"four-fast","format":"wav"}`, "inputs"},
		{"bad file", []string{bad}, `{"preset":"four-fast","format":"wav"}`, "inputs.0"},
		{"bad preset", []string{good}, `{"preset":"x","format":"wav"}`, "preset"},
		{"empty options", []string{good}, `{}`, "preset"},
		{"bad format", []string{good}, `{"preset":"four-fast","format":"ogg"}`, "format"},
		{"unknown field", []string{good}, `{"preset":"four-fast","format":"wav","x":1}`, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.inputs, json.RawMessage(tc.opts))
			if tc.name == "ok" || tc.name == "ok flac best" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !core.IsCode(err, core.CodeValidation) {
				t.Fatalf("want validation error, got %v", err)
			}
			if tc.field != "" {
				var ae *core.AppError
				errors.As(err, &ae)
				if _, ok := ae.Fields[tc.field]; !ok {
					t.Fatalf("fields %v lack %q", ae.Fields, tc.field)
				}
			}
		})
	}
}

func TestRunHappyPath(t *testing.T) {
	input := touch(t, "Song.mp3")
	r := &rec{}
	job := newJob(t, r, input, `{"preset":"four-best","format":"flac"}`)
	vp := filepath.Join(job.OutputDir, "Song", "Song - Vocals.flac")
	dp := filepath.Join(job.OutputDir, "Song", "Song - Drums.flac")
	fc := &fakeCaller{
		events: []sidecar.Event{
			{Kind: "progress", Pct: 0.5, Msg: "Separating"},
			{Kind: "log", Line: "info", Level: "info"},
			{Kind: "log", Line: "warn", Level: "warning"},
			{Kind: "output", Path: vp},
		},
	}
	res, _ := json.Marshal(map[string]any{"model": "htdemucs_ft.yaml", "rssBytes": 5,
		"stems": []map[string]string{{"name": "Vocals", "path": vp}, {"name": "Drums", "path": dp}}})
	fc.result = string(res)
	m := &Module{sc: fc}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if fc.method != "stems.separate" {
		t.Fatalf("method %q", fc.method)
	}
	want := map[string]any{"input": input, "outputDir": filepath.Join(job.OutputDir, "Song"),
		"model": "htdemucs_ft.yaml", "outputFormat": "flac", "baseName": "Song"}
	if !reflect.DeepEqual(fc.params, want) {
		t.Fatalf("params %v want %v", fc.params, want)
	}
	if st, err := os.Stat(filepath.Join(job.OutputDir, "Song")); err != nil || !st.IsDir() {
		t.Fatal("output folder not created")
	}
	if r.title != "Song.mp3" {
		t.Fatalf("title %q", r.title)
	}
	if !reflect.DeepEqual(r.outputs, []string{vp, dp}) {
		t.Fatalf("outputs %v", r.outputs)
	}
	if !reflect.DeepEqual(r.logs, []string{"stdout:info", "stderr:warn"}) {
		t.Fatalf("logs %v", r.logs)
	}
	if r.progress[0] != "Separating" || r.pcts[0] != 0.5 {
		t.Fatalf("progress %v", r.progress)
	}
	if last := len(r.progress) - 1; r.progress[last] != "2 stems" || r.pcts[last] != 1 {
		t.Fatalf("final progress %v", r.progress)
	}
	var got struct {
		Preset, Model string
		Stems         []stemFile
	}
	if err := json.Unmarshal(r.result, &got); err != nil {
		t.Fatal(err)
	}
	if got.Preset != "four-best" || got.Model != "htdemucs_ft.yaml" || len(got.Stems) != 2 || got.Stems[1].Name != "Drums" {
		t.Fatalf("result %s", r.result)
	}
}

func TestRunErrors(t *testing.T) {
	input := touch(t, "s.wav")
	opts := `{"preset":"four-fast","format":"wav"}`

	t.Run("engine missing", func(t *testing.T) {
		r := &rec{toolErr: core.ErrDependencyMissing(sidecar.DepID, "Install it")}
		fc := &fakeCaller{}
		err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, input, opts))
		if err != r.toolErr || fc.calls != 0 {
			t.Fatalf("err %v calls %d", err, fc.calls)
		}
	})
	t.Run("app error passthrough", func(t *testing.T) {
		want := core.Errorf(core.CodeToolFailed, "boom").WithHint("h")
		err := (&Module{sc: &fakeCaller{err: want}}).Run(context.Background(), newJob(t, &rec{}, input, opts))
		if err != want {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := (&Module{sc: &fakeCaller{block: true}}).Run(ctx, newJob(t, &rec{}, input, opts))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("bad options", func(t *testing.T) {
		fc := &fakeCaller{}
		err := (&Module{sc: fc}).Run(context.Background(), newJob(t, &rec{}, input, `{"preset":"zz","format":"wav"}`))
		if !core.IsCode(err, core.CodeValidation) || fc.calls != 0 {
			t.Fatalf("got %v", err)
		}
	})
}
