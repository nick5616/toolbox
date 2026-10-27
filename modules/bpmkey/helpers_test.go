package bpmkey

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
