package stems

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultFormatIsFLAC(t *testing.T) {
	if DefaultOptions().Format != FormatFLAC {
		t.Errorf("default format %q", DefaultOptions().Format)
	}
}

func TestModelProvider(t *testing.T) {
	dir := t.TempDir()
	fc := &fakeCaller{result: `{}`}
	m := &Module{sc: fc}
	m.SetModelsDir(dir)
	job := newJob(t, &rec{}, touch(t, "a.mp3"), `{}`)
	sep := filepath.Join(dir, "audio-separator")
	write := func(name, body string) {
		t.Helper()
		if err := os.MkdirAll(sep, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sep, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if m.ModelPresent("four-fast") || m.ModelPresent("nope") {
		t.Fatal("present before download")
	}
	if err := m.FetchModel(context.Background(), job, "four-fast"); err != nil {
		t.Fatal(err)
	}
	if fc.method != "stems.prefetch" || fc.calls != 1 {
		t.Fatalf("calls %d method %q", fc.calls, fc.method)
	}
	if fc.params.(map[string]any)["model"] != "htdemucs.yaml" {
		t.Errorf("params %v", fc.params)
	}

	// The yaml alone is not enough: its checkpoint must exist too.
	write("htdemucs.yaml", "models: ['955717e8']")
	if m.ModelPresent("four-fast") {
		t.Fatal("present without its checkpoint")
	}
	write("955717e8-8726e21a.th", "ckpt")
	if !m.ModelPresent("four-fast") {
		t.Fatal("not present after both files")
	}
	if err := m.FetchModel(context.Background(), job, "four-fast"); err != nil || fc.calls != 1 {
		t.Errorf("fetch when present: err %v calls %d", err, fc.calls)
	}

	// A plain single-file model.
	write("UVR-MDX-NET-Inst_HQ_3.onnx", "x")
	if !m.ModelPresent("vocals-fast") {
		t.Error("single-file model not present")
	}

	write("other.th", "keep")
	if err := m.RemoveModel("four-fast"); err != nil || m.ModelPresent("four-fast") {
		t.Errorf("remove: %v", err)
	}
	if _, err := os.Stat(filepath.Join(sep, "other.th")); err != nil {
		t.Error("remove deleted an unrelated file")
	}
	if _, err := os.Stat(filepath.Join(sep, "955717e8-8726e21a.th")); err == nil {
		t.Error("checkpoint survived remove")
	}
}
