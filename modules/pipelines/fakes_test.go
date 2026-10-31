package pipelines

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
)

// memOutputs is an in-memory core.OutputStore.
type memOutputs struct {
	mu    sync.Mutex
	items map[string]core.Output
	moved []string // "id -> newPath"
	n     int
}

func newMemOutputs() *memOutputs { return &memOutputs{items: map[string]core.Output{}} }

func (s *memOutputs) add(path string) core.Output {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	o := core.Output{ID: fmt.Sprintf("out%d", s.n), Path: path, Name: filepath.Base(path), Kind: core.KindForPath(path)}
	s.items[o.ID] = o
	return o
}

func (s *memOutputs) UpsertOutput(ctx context.Context, o core.Output) (core.Output, error) {
	return s.add(o.Path), nil
}

func (s *memOutputs) GetOutput(ctx context.Context, id string) (core.Output, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.items[id]
	if !ok {
		return core.Output{}, core.Errorf(core.CodeNotFound, "no output %s", id)
	}
	return o, nil
}

func (s *memOutputs) ListOutputs(ctx context.Context, q core.OutputQuery) (core.OutputPage, error) {
	return core.OutputPage{}, nil
}

func (s *memOutputs) DeleteOutput(ctx context.Context, id string) error { return nil }

func (s *memOutputs) MoveOutput(ctx context.Context, id, newPath string) (core.Output, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.items[id]
	if !ok {
		return core.Output{}, core.Errorf(core.CodeNotFound, "no output %s", id)
	}
	o.Path, o.Name = newPath, filepath.Base(newPath)
	s.items[id] = o
	s.moved = append(s.moved, id+" -> "+newPath)
	return o, nil
}

// fakeTG is a core.TextGenerator whose replies come from a function.
type fakeTG struct {
	mu        sync.Mutex
	ready     error
	ctxTokens int
	reply     func(req core.CompletionRequest, n int) (string, error)
	reqs      []core.CompletionRequest
}

func (f *fakeTG) Ready() (string, error) { return "fake-model", f.ready }

func (f *fakeTG) ContextTokens() int {
	if f.ctxTokens == 0 {
		return 8192
	}
	return f.ctxTokens
}

func (f *fakeTG) Complete(ctx context.Context, req core.CompletionRequest) (string, error) {
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	n := len(f.reqs)
	f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return f.reply(req, n)
}

// harness runs module jobs against a temp library.
type harness struct {
	t       *testing.T
	m       *Module
	outputs *memOutputs
	library string
	events  []string
}

func newHarness(t *testing.T, tg core.TextGenerator) *harness {
	t.Helper()
	h := &harness{t: t, outputs: newMemOutputs(), library: filepath.Join(t.TempDir(), "Library")}
	if err := os.MkdirAll(h.library, 0o755); err != nil {
		t.Fatal(err)
	}
	h.m = &Module{
		tg: tg, outputs: h.outputs, libraryDir: func() string { return h.library },
		em: core.EmitterFunc(func(name string, data any) { h.events = append(h.events, name) }),
	}
	return h
}

// jobRun is what a job recorded.
type jobRun struct {
	outputs []core.Output
	result  json.RawMessage
	logs    []string
}

func (r *jobRun) files(t *testing.T) []core.RunFile {
	t.Helper()
	var jr jobResult
	if err := json.Unmarshal(r.result, &jr); err != nil {
		t.Fatalf("result: %v (%s)", err, r.result)
	}
	return jr.Files
}

func (r *jobRun) vars(t *testing.T) map[string]string {
	t.Helper()
	var jr jobResult
	if err := json.Unmarshal(r.result, &jr); err != nil {
		t.Fatal(err)
	}
	return jr.Vars
}

func (h *harness) run(o Options) (*jobRun, error) {
	return h.runCtx(context.Background(), o)
}

func (h *harness) runCtx(ctx context.Context, o Options) (*jobRun, error) {
	h.t.Helper()
	raw, err := json.Marshal(o)
	if err != nil {
		h.t.Fatal(err)
	}
	rec := &jobRun{}
	outDir := filepath.Join(h.library, "Pipelines")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		h.t.Fatal(err)
	}
	job := core.NewJobContext(core.JobContext{ID: "job1", ModuleID: ModuleID, Options: raw, OutputDir: outDir, TempDir: h.t.TempDir()}, core.JobHooks{
		Log: func(_ core.LogStream, line string) { rec.logs = append(rec.logs, line) },
		Output: func(path string) (core.Output, error) {
			if _, err := os.Stat(path); err != nil {
				return core.Output{}, err
			}
			out := h.outputs.add(path)
			rec.outputs = append(rec.outputs, out)
			return out, nil
		},
		Result: func(r json.RawMessage) { rec.result = r },
	})
	return rec, h.m.Run(ctx, job)
}

func writeFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func contains(lines []string, sub string) bool {
	for _, l := range lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}
