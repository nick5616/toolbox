package visualizer

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMoodFiles(t *testing.T) {
	cases := []struct{ goos, goarch, model string }{
		{"darwin", "arm64", "model_qint8_arm64.onnx"},
		{"windows", "amd64", "model_quint8_avx2.onnx"},
		{"darwin", "amd64", "model_quint8_avx2.onnx"},
		{"linux", "arm64", "model_quint8_avx2.onnx"},
	}
	for _, c := range cases {
		fs := moodFiles(c.goos, c.goarch)
		if len(fs) != 2 || fs[0].File != c.model || fs[1].File != "tokenizer.json" {
			t.Errorf("%s/%s: %+v", c.goos, c.goarch, fs)
		}
		for _, f := range fs {
			if len(f.SHA256) != 64 || f.URL == "" || f.Bytes <= 0 {
				t.Errorf("bad pin %+v", f)
			}
		}
	}
}

func TestModelPresence(t *testing.T) {
	m, _ := newTestModule(t)
	if m.ModelPresent(PresetMood) {
		t.Error("present before download")
	}
	if _, _, ok := m.moodModel(); ok {
		t.Error("moodModel ok before download")
	}
	for _, f := range moodFiles(runtime.GOOS, runtime.GOARCH) {
		writeFile(t, filepath.Join(m.moodDir(), f.File))
	}
	if !m.ModelPresent(PresetMood) {
		t.Fatal("not present after writing files")
	}
	model, tok, ok := m.moodModel()
	if !ok || filepath.Base(tok) != "tokenizer.json" || filepath.Dir(model) != m.moodDir() {
		t.Errorf("moodModel = %q %q %v", model, tok, ok)
	}
	if m.ModelPresent("other") {
		t.Error("unknown preset present")
	}
	if err := m.RemoveModel(PresetMood); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(m.moodDir()); !os.IsNotExist(err) {
		t.Error("mood folder not removed")
	}
	if err := m.RemoveModel(PresetMood); err != nil {
		t.Errorf("removing twice: %v", err)
	}
	if (&Module{}).ModelPresent(PresetMood) {
		t.Error("present without a models dir")
	}
}
