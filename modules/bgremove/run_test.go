package bgremove

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
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.calls++
	f.method, f.params = method, params
	for _, ev := range f.events {
		onEvent(ev)
	}
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.result), nil
}

type rec struct {
	title    string
	progress []string
	outputs  []string
	result   json.RawMessage
	toolErr  error
}

func (r *rec) hooks() core.JobHooks {
	return core.JobHooks{
		Progress: func(_ float64, m string) { r.progress = append(r.progress, m) },
		Log:      func(core.LogStream, string) {},
		Title:    func(t string) { r.title = t },
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool:   func(string) (string, error) { return "/engine", r.toolErr },
		Result: func(b json.RawMessage) { r.result = b },
	}
}

func touch(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func newJob(t *testing.T, r *rec, input, opts string) *core.JobContext {
	t.Helper()
	return core.NewJobContext(core.JobContext{Inputs: []string{input}, Options: json.RawMessage(opts), OutputDir: t.TempDir()}, r.hooks())
}

const goodOpts = `{"model":"balanced","output":"transparent","color":"#ffffff","crop":true,"padding":10,"cleanEdges":true,"refine":false}`

func TestValidate(t *testing.T) {
	good := touch(t, "a.jpg")
	heic := touch(t, "a.HEIC")
	bad := touch(t, "a.txt")
	m := &Module{}
	tests := []struct {
		name   string
		inputs []string
		opts   string
		field  string
	}{
		{"ok", []string{good}, goodOpts, ""},
		{"ok heic", []string{heic}, goodOpts, ""},
		{"ok color", []string{good}, `{"model":"fast","output":"color","color":"#A0b1C2","padding":0}`, ""},
		{"no inputs", nil, goodOpts, "inputs"},
		{"bad file", []string{bad}, goodOpts, "inputs.0"},
		{"bad model", []string{good}, `{"model":"huge","output":"mask"}`, "model"},
		{"bad output", []string{good}, `{"model":"fast","output":"x"}`, "output"},
		{"color needs hex", []string{good}, `{"model":"fast","output":"color","color":"red"}`, "color"},
		{"color ignored otherwise", []string{good}, `{"model":"fast","output":"mask","color":"red"}`, ""},
		{"padding high", []string{good}, `{"model":"fast","output":"mask","padding":501}`, "padding"},
		{"padding negative", []string{good}, `{"model":"fast","output":"mask","padding":-1}`, "padding"},
		{"unknown field", []string{good}, `{"model":"fast","output":"mask","x":1}`, "-"},
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

func TestRun(t *testing.T) {
	input := touch(t, "Cat.jpg")
	r := &rec{}
	job := newJob(t, r, input, goodOpts)
	out := filepath.Join(job.OutputDir, "Cat (no background).png")
	fc := &fakeCaller{
		events: []sidecar.Event{
			{Kind: "progress", Pct: 0.5, Msg: "Downloading model"},
			{Kind: "output", Path: out},
		},
		result: `{"width":1600,"height":1200,"subjectCoverage":0.381,"model":"balanced","output":` + mustJSON(out) + `}`,
	}
	m := &Module{sc: fc, modelsDir: "/models"}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	spec := models[ModelBalanced]
	want := map[string]any{
		"input": input, "outputDir": job.OutputDir, "baseName": "Cat",
		"model":    map[string]any{"file": spec.File, "sha256": spec.SHA256, "url": spec.URL, "kind": "birefnet"},
		"modelDir": filepath.Join("/models", "bg"), "output": "transparent", "color": "#ffffff",
		"crop": true, "padding": 10, "cleanEdges": true, "refine": false,
	}
	if fc.method != "bgremove.run" || !reflect.DeepEqual(fc.params, want) {
		t.Fatalf("method %q params %v", fc.method, fc.params)
	}
	if r.title != "Cat.jpg" {
		t.Fatalf("title %q", r.title)
	}
	if len(r.outputs) != 1 || r.outputs[0] != out {
		t.Fatalf("outputs %v (must register once)", r.outputs)
	}
	if last := r.progress[len(r.progress)-1]; last != "Subject covers 38% · 1600×1200" {
		t.Fatalf("final %q", last)
	}
	if r.result == nil {
		t.Fatal("no result")
	}
}

func TestRunNoSubject(t *testing.T) {
	input := touch(t, "a.png")
	r := &rec{}
	fc := &fakeCaller{result: `{"width":10,"height":10,"subjectCoverage":0.001,"model":"fast","output":""}`}
	if err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, input, `{"model":"fast","output":"mask"}`)); err != nil {
		t.Fatal(err)
	}
	if last := r.progress[len(r.progress)-1]; last != "No clear subject found" {
		t.Fatalf("final %q", last)
	}
}

func TestRunErrors(t *testing.T) {
	input := touch(t, "s.png")
	t.Run("engine missing", func(t *testing.T) {
		r := &rec{toolErr: core.ErrDependencyMissing(sidecar.DepID, "Install it")}
		fc := &fakeCaller{}
		err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, input, goodOpts))
		if err != r.toolErr || fc.calls != 0 {
			t.Fatalf("err %v calls %d", err, fc.calls)
		}
	})
	t.Run("passthrough", func(t *testing.T) {
		want := core.Errorf(core.CodeToolFailed, "boom")
		err := (&Module{sc: &fakeCaller{err: want}}).Run(context.Background(), newJob(t, &rec{}, input, goodOpts))
		if err != want {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("bad result", func(t *testing.T) {
		err := (&Module{sc: &fakeCaller{result: "nope"}}).Run(context.Background(), newJob(t, &rec{}, input, goodOpts))
		if !core.IsCode(err, core.CodeInternal) {
			t.Fatalf("got %v", err)
		}
	})
}

func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
