package converter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
)

func touch(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func fieldsOf(t *testing.T, err error) map[string]string {
	t.Helper()
	ae := core.AsAppError(err)
	if ae == nil {
		t.Fatalf("not an AppError: %v", err)
	}
	return ae.Fields
}

func TestValidateKinds(t *testing.T) {
	files := map[string]string{
		"audio": touch(t, "a.wav"), "video": touch(t, "v.mp4"), "image": touch(t, "i.png"),
	}
	tests := []struct {
		preset Preset
		kind   string
		ok     bool
	}{
		{"mp3-320", "audio", true}, {"mp3-320", "video", true}, {"mp3-320", "image", false},
		{"flac", "image", false},
		{"mp4-h264", "video", true}, {"mp4-h264", "audio", false}, {"mp4-h264", "image", false},
		{"png", "image", true}, {"png", "audio", false}, {"webp", "video", false},
	}
	m := &Module{}
	for _, tt := range tests {
		raw, _ := json.Marshal(Options{Preset: tt.preset, MaxHeight: HeightKeep})
		err := m.Validate([]string{files[tt.kind]}, raw)
		if (err == nil) != tt.ok {
			t.Errorf("%s/%s: err = %v", tt.preset, tt.kind, err)
			continue
		}
		if err != nil {
			p, _ := lookup(tt.preset)
			want := p.Label + " can't take a " + tt.kind + " file"
			if got := fieldsOf(t, err)["inputs.0"]; got != want {
				t.Errorf("field = %q, want %q", got, want)
			}
		}
	}
}

func TestValidateOptions(t *testing.T) {
	f := touch(t, "a.wav")
	m := &Module{}
	for name, tc := range map[string]struct{ raw, field string }{
		"bad preset": {`{"preset":"x","maxHeight":"keep"}`, "preset"},
		"bad height": {`{"preset":"mp3-320","maxHeight":"999"}`, "maxHeight"},
		"empty":      {`{}`, "preset"},
	} {
		err := m.Validate([]string{f}, json.RawMessage(tc.raw))
		if _, ok := fieldsOf(t, err)[tc.field]; !ok {
			t.Errorf("%s: fields = %v", name, fieldsOf(t, err))
		}
	}
	if err := m.Validate([]string{f}, json.RawMessage(`{"nope":1}`)); err == nil {
		t.Error("unknown field accepted")
	}
}

func TestValidateFiles(t *testing.T) {
	m := &Module{}
	raw, _ := json.Marshal(DefaultOptions())
	if err := m.Validate(nil, raw); err == nil {
		t.Error("no inputs accepted")
	}
	if err := m.Validate([]string{filepath.Join(t.TempDir(), "missing.wav")}, raw); err == nil {
		t.Error("missing file accepted")
	}
	if err := m.Validate([]string{touch(t, "a.txt")}, raw); err == nil {
		t.Error("txt accepted")
	}
	if err := m.Validate([]string{touch(t, "a.wav")}, raw); err != nil {
		t.Errorf("valid rejected: %v", err)
	}
}
