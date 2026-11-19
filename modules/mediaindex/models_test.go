package mediaindex

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
	method string
	params map[string]any
	calls  int
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, on func(sidecar.Event)) (json.RawMessage, error) {
	f.calls++
	f.method = method
	raw, _ := json.Marshal(params)
	_ = json.Unmarshal(raw, &f.params)
	on(sidecar.Event{Kind: "progress", Pct: 0.5, Msg: "Downloading model"})
	on(sidecar.Event{Kind: "log", Level: "warning", Line: "slow"})
	on(sidecar.Event{Kind: "log", Level: "info", Line: "ok"})
	return json.RawMessage(`{}`), nil
}

type seen struct {
	pct   []float64
	logs  []string
	errs  int
	tools []string
}

func testJob(s *seen, toolErr error) *core.JobContext {
	return core.NewJobContext(core.JobContext{ID: "j"}, core.JobHooks{
		Progress: func(p float64, _ string) { s.pct = append(s.pct, p) },
		Log: func(st core.LogStream, l string) {
			if st == core.StreamStderr {
				s.errs++
			}
			s.logs = append(s.logs, l)
		},
		Tool: func(id string) (string, error) { s.tools = append(s.tools, id); return "x", toolErr },
	})
}

func writeModel(t *testing.T, dir string) {
	t.Helper()
	for _, f := range ModelFiles {
		p := filepath.Join(dir, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestFetchModelCallsPrefetch(t *testing.T) {
	models := t.TempDir()
	fc := &fakeCaller{}
	m := &IndexModule{d: Deps{Caller: fc, ModelsDir: models}}
	var s seen
	if err := m.FetchModel(context.Background(), testJob(&s, nil), ModelPreset); err != nil {
		t.Fatal(err)
	}
	if fc.method != "search.prefetch" {
		t.Fatalf("method %q", fc.method)
	}
	if fc.params["modelDir"] != ModelInfo(models).Dir {
		t.Fatalf("modelDir %v", fc.params["modelDir"])
	}
	files, _ := fc.params["files"].([]any)
	if len(files) != len(ModelFiles) {
		t.Fatalf("files %d", len(files))
	}
	first := files[0].(map[string]any)
	if first["path"] != "visual/model.onnx" || first["sha256"] != ModelFiles[0].SHA256 ||
		first["url"] != ModelFiles[0].URL() || int64(first["bytes"].(float64)) != ModelFiles[0].Bytes {
		t.Fatalf("first file %v", first)
	}
	if len(s.tools) != 1 || s.tools[0] != sidecar.DepID {
		t.Fatalf("tools %v", s.tools)
	}
	if len(s.pct) != 1 || s.pct[0] != 0.5 || len(s.logs) != 2 || s.errs != 1 {
		t.Fatalf("mapping: %+v", s)
	}
}

func TestFetchModelNoOpWhenPresentAndFailsFastWithoutEngine(t *testing.T) {
	models := t.TempDir()
	fc := &fakeCaller{}
	m := &IndexModule{d: Deps{Caller: fc, ModelsDir: models}}
	var s seen
	if err := m.FetchModel(context.Background(), testJob(&s, core.ErrDependencyMissing(sidecar.DepID, "")), ModelPreset); err == nil || fc.calls != 0 {
		t.Fatalf("want dependency error without a call, got %v (%d calls)", err, fc.calls)
	}
	writeModel(t, ModelInfo(models).Dir)
	s = seen{}
	if err := m.FetchModel(context.Background(), testJob(&s, nil), ModelPreset); err != nil || fc.calls != 0 || len(s.tools) != 0 {
		t.Fatalf("present should be a no-op: %v %d", err, fc.calls)
	}
	if err := m.FetchModel(context.Background(), testJob(&s, nil), "other"); err == nil {
		t.Fatal("unknown preset should fail")
	}
}

func TestModelPresentAndRemove(t *testing.T) {
	models := t.TempDir()
	m := &IndexModule{d: Deps{ModelsDir: models}}
	if m.ModelPresent(ModelPreset) {
		t.Fatal("empty dir is not present")
	}
	dir := ModelInfo(models).Dir
	writeModel(t, dir)
	if !m.ModelPresent(ModelPreset) || m.ModelPresent("other") {
		t.Fatal("present/other wrong")
	}
	if err := os.Remove(filepath.Join(dir, "config.json")); err != nil {
		t.Fatal(err)
	}
	if m.ModelPresent(ModelPreset) {
		t.Fatal("a missing file means not present")
	}
	writeModel(t, dir)
	if err := m.RemoveModel(ModelPreset); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dir should be gone: %v", err)
	}
	if err := m.RemoveModel(ModelPreset); err != nil {
		t.Fatal(err)
	}
}
