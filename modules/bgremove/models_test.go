package bgremove

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
	job := newJob(t, &rec{}, touch(t, "a.jpg"), goodOpts)

	if m.ModelPresent("balanced") || m.ModelPresent("nope") {
		t.Fatal("present before download")
	}
	if err := m.FetchModel(context.Background(), job, "balanced"); err != nil {
		t.Fatal(err)
	}
	if fc.method != "bgremove.prefetch" || fc.calls != 1 {
		t.Fatalf("calls %d method %q", fc.calls, fc.method)
	}
	params := fc.params.(map[string]any)
	if params["modelDir"] != filepath.Join(dir, "bg") {
		t.Errorf("modelDir %v", params["modelDir"])
	}
	file := filepath.Join(dir, "bg", models[ModelBalanced].File)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !m.ModelPresent("balanced") {
		t.Fatal("not present after write")
	}
	if err := m.FetchModel(context.Background(), job, "balanced"); err != nil || fc.calls != 1 {
		t.Errorf("fetch when present: err %v calls %d", err, fc.calls)
	}
	if err := m.RemoveModel("balanced"); err != nil || m.ModelPresent("balanced") {
		t.Errorf("remove: %v", err)
	}
	if err := m.FetchModel(context.Background(), job, "bogus"); err == nil {
		t.Error("unknown preset accepted")
	}
}
