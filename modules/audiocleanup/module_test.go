package audiocleanup

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
	err    error
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.method = method
	f.params, _ = params.(map[string]any)
	onEvent(sidecar.Event{Kind: "progress", Pct: 0.5, Msg: "x"})
	return json.RawMessage(`{}`), f.err
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
	m := &Module{}
	good := touch(t, "a.wav")
	vid := touch(t, "b.MP4")
	bad := touch(t, "c.txt")
	def, _ := json.Marshal(DefaultOptions())
	if err := m.Validate([]string{good, vid}, def); err != nil {
		t.Fatal(err)
	}
	if err := m.Validate([]string{bad}, def); err == nil {
		t.Fatal("txt should be rejected")
	}
	o := DefaultOptions()
	o.Denoise = "bogus"
	o.PreviewStartMs = -1
	raw, _ := json.Marshal(o)
	err := m.Validate([]string{good}, raw)
	ae, ok := err.(*core.AppError)
	if !ok || ae.Fields["denoise"] == "" || ae.Fields["previewStartMs"] == "" {
		t.Fatalf("got %v", err)
	}
	if err := m.Validate([]string{good}, json.RawMessage(`{"nope":1}`)); err == nil {
		t.Fatal("unknown fields should be rejected")
	}
}

func TestDefaults(t *testing.T) {
	o := DefaultOptions()
	if !o.HighPass || o.Hum != HumAuto || o.Denoise != DenoiseVoice || o.Loudness != LoudnessPodcast || o.Format != FormatSame {
		t.Fatalf("%+v", o)
	}
}

func TestModelLifecycle(t *testing.T) {
	dir := t.TempDir()
	fc := &fakeCaller{}
	m := &Module{sc: fc, modelsDir: dir}
	if m.ModelPresent(PresetVoice) || m.ModelPresent("nope") {
		t.Fatal("nothing is installed yet")
	}
	md := filepath.Join(dir, "denoise", "dfn3")
	if err := os.MkdirAll(md, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range dfn3Model.Files {
		if err := os.WriteFile(filepath.Join(md, f.Name), make([]byte, f.Bytes), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if !m.ModelPresent(PresetVoice) {
		t.Fatal("expected present")
	}
	// A truncated file counts as missing.
	if err := os.WriteFile(filepath.Join(md, "enc.onnx"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if m.ModelPresent(PresetVoice) {
		t.Fatal("size mismatch should be missing")
	}
	if err := m.RemoveModel(PresetVoice); err != nil {
		t.Fatal(err)
	}
	if err := m.RemoveModel(PresetVoice); err != nil {
		t.Fatal("removing twice must be fine:", err)
	}
	for _, f := range dfn3Model.Files {
		if _, err := os.Stat(filepath.Join(md, f.Name)); !os.IsNotExist(err) {
			t.Fatalf("%s survived", f.Name)
		}
	}
}

func TestFetchModelCallsPrefetch(t *testing.T) {
	fc := &fakeCaller{}
	m := &Module{sc: fc, modelsDir: t.TempDir()}
	job := core.NewJobContext(core.JobContext{}, core.JobHooks{
		Tool: func(string) (string, error) { return "/engine", nil },
	})
	if err := m.FetchModel(context.Background(), job, PresetVoice); err != nil {
		t.Fatal(err)
	}
	if fc.method != "denoise.prefetch" {
		t.Fatalf("method %q", fc.method)
	}
	model, _ := fc.params["model"].(map[string]any)
	if model["sha256"] != dfn3Model.SHA256 || fc.params["modelDir"] != m.voiceModelDir() {
		t.Fatalf("params %v", fc.params)
	}
	if files, _ := fc.params["files"].([]map[string]any); len(files) != 3 {
		t.Fatalf("files %v", fc.params["files"])
	}
	if err := m.FetchModel(context.Background(), job, "other"); err == nil {
		t.Fatal("unknown preset should fail")
	}
	// Engine missing: fails before calling.
	fc2 := &fakeCaller{}
	m2 := &Module{sc: fc2, modelsDir: t.TempDir()}
	missing := core.NewJobContext(core.JobContext{}, core.JobHooks{
		Tool: func(string) (string, error) { return "", core.ErrDependencyMissing(sidecar.DepID, "install") },
	})
	if err := m2.FetchModel(context.Background(), missing, PresetVoice); err == nil || fc2.method != "" {
		t.Fatalf("err %v method %q", err, fc2.method)
	}
}

func TestRunVoiceNeedsModel(t *testing.T) {
	m := &Module{sc: &fakeCaller{}, modelsDir: t.TempDir()}
	in := touch(t, "a.wav")
	raw, _ := json.Marshal(DefaultOptions())
	job := core.NewJobContext(core.JobContext{Inputs: []string{in}, Options: raw, OutputDir: t.TempDir(), TempDir: t.TempDir()}, core.JobHooks{
		Tool: func(string) (string, error) { return "/x", nil },
	})
	err := m.Run(context.Background(), job)
	ae, ok := err.(*core.AppError)
	if !ok || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("got %v", err)
	}
}
