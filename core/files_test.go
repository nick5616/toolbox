package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateFileInputs(t *testing.T) {
	dir := t.TempDir()
	ok := filepath.Join(dir, "a.MP3")
	bad := filepath.Join(dir, "b.zip")
	must(t, os.WriteFile(ok, []byte("x"), 0o644))
	must(t, os.WriteFile(bad, []byte("x"), 0o644))
	exts := []string{".mp3", ".wav"}

	if err := ValidateFileInputs([]string{ok}, exts); err != nil {
		t.Fatalf("valid: %v", err)
	}
	err := ValidateFileInputs([]string{ok, bad, filepath.Join(dir, "missing.mp3"), dir, "rel.mp3"}, exts)
	ae := AsAppError(err)
	if ae.Code != CodeValidation {
		t.Fatalf("err = %v", err)
	}
	want := map[string]string{
		"inputs.1": "Unsupported file type (.zip)",
		"inputs.2": "File not found",
		"inputs.3": "Not a file",
		"inputs.4": "File not found",
	}
	for k, v := range want {
		if ae.Fields[k] != v {
			t.Errorf("%s = %q, want %q", k, ae.Fields[k], v)
		}
	}
	if _, has := ae.Fields["inputs.0"]; has {
		t.Error("valid input flagged")
	}
	if ae := AsAppError(ValidateFileInputs(nil, exts)); ae.Fields["inputs"] == "" {
		t.Error("empty inputs accepted")
	}
}

func TestStatFiles(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "s.wav")
	must(t, os.WriteFile(f, []byte("abcd"), 0o644))
	got := StatFiles([]string{f, filepath.Join(dir, "nope.mp4"), dir})
	if !got[0].Exists || got[0].SizeBytes != 4 || got[0].Kind != KindAudio || got[0].Name != "s.wav" {
		t.Errorf("file = %+v", got[0])
	}
	if got[1].Exists || got[1].Kind != KindVideo {
		t.Errorf("missing = %+v", got[1])
	}
	if !got[2].IsDir {
		t.Errorf("dir = %+v", got[2])
	}
}

func TestSetResult(t *testing.T) {
	var got json.RawMessage
	j := NewJobContext(JobContext{}, JobHooks{Result: func(r json.RawMessage) { got = r }})
	if err := j.SetResult(map[string]any{"bpm": 120.5}); err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"bpm":120.5}` {
		t.Fatalf("result = %s", got)
	}
	big := make([]byte, MaxResultBytes)
	if err := j.SetResult(string(big)); !IsCode(err, CodeValidation) {
		t.Fatalf("oversize err = %v", err)
	}
}

func TestUniquePath(t *testing.T) {
	dir := t.TempDir()
	if got := UniquePath(dir, "a", ".mp3"); got != filepath.Join(dir, "a.mp3") {
		t.Fatalf("got %s", got)
	}
	must(t, os.WriteFile(filepath.Join(dir, "a.mp3"), nil, 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "a (1).mp3"), nil, 0o644))
	if got := UniquePath(dir, "a", ".mp3"); got != filepath.Join(dir, "a (2).mp3") {
		t.Fatalf("got %s", got)
	}
	if StemName("/x/Song.final.wav") != "Song.final" {
		t.Fatal("StemName")
	}
}
