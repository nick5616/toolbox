package bpmkey

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	m := &Module{}
	info, err := m.DescribeStep(json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 0 || info.Summary != "BPM & Key" || len(info.Accepts.Extensions) == 0 {
		t.Errorf("info = %+v", info)
	}
	names := []string{"bpm", "bpm_exact", "key", "key_short", "camelot"}
	if len(info.Vars) != len(names) {
		t.Fatalf("vars = %+v", info.Vars)
	}
	for i, v := range info.Vars {
		if v.Name != names[i] || v.Label == "" {
			t.Errorf("var %d = %+v", i, v)
		}
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"x":1}`)); err == nil {
		t.Error("unknown options should be rejected")
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	var files []core.RunFile
	for _, n := range []string{"a.mp3", "b.flac"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, core.RunFile{Path: p})
	}
	jobs, err := (&Module{}).PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: files}})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("jobs = %+v, want one submission with both files", jobs)
	}
	if _, err := (&Module{}).PrepareStep(context.Background(), core.StepRequest{}); err == nil {
		t.Error("no files should be rejected")
	}
}

func TestKeyShort(t *testing.T) {
	for in, want := range map[string]string{"A minor": "Am", "F# major": "F#", "C major": "C", "Bb minor": "Bbm", "": "", "G": "G"} {
		if got := keyShort(in); got != want {
			t.Errorf("keyShort(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStepOutputs(t *testing.T) {
	m := &Module{}
	res, err := m.StepOutputs(core.Job{ResultJSON: `{"bpm":127.86,"key":"A minor","camelot":"8A","confidence":0.8}`})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"bpm": "128", "bpm_exact": "127.9", "key": "A minor", "key_short": "Am", "camelot": "8A"}
	for k, v := range want {
		if res.Vars[k] != v {
			t.Errorf("%s = %q, want %q", k, res.Vars[k], v)
		}
	}
	if len(res.Files) != 0 {
		t.Errorf("files = %+v, want none", res.Files)
	}
	if _, err := m.StepOutputs(core.Job{}); err == nil {
		t.Error("a missing result should be an error")
	}
}
