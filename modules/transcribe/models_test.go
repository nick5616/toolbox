package transcribe

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestModelProvider(t *testing.T) {
	dir := t.TempDir()
	fc := &fakeCaller{result: `{}`}
	m := &Module{sc: fc, modelsDir: dir}
	job := newJob(t, &rec{}, touch(t, "a.mp3"), `{}`)

	if m.ModelPresent("small") || m.ModelPresent("nope") {
		t.Fatal("present before download")
	}
	if err := m.FetchModel(context.Background(), job, "small"); err != nil {
		t.Fatal(err)
	}
	if fc.method != "transcribe.prefetch" || fc.calls != 1 {
		t.Fatalf("calls %d method %q", fc.calls, fc.method)
	}
	params := fc.params.(map[string]any)
	if params["model"] != "Systran/faster-whisper-small" || params["modelDir"] != filepath.Join(dir, "whisper", "small") {
		t.Errorf("params %v", params)
	}
	mdir := filepath.Join(dir, "whisper", "small")
	if err := os.MkdirAll(mdir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mdir, "model.bin"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !m.ModelPresent("small") {
		t.Fatal("not present after write")
	}
	if err := m.FetchModel(context.Background(), job, "small"); err != nil || fc.calls != 1 {
		t.Errorf("fetch when present: err %v calls %d", err, fc.calls)
	}
	if err := m.RemoveModel("small"); err != nil || m.ModelPresent("small") {
		t.Errorf("remove: %v", err)
	}
}
