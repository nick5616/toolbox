package upscale

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCPUPinAndProvider(t *testing.T) {
	pin, ok := CPUPin(PhotoPreset)
	if !ok || pin.File != "RealESRGAN_x4plus.pth" || len(pin.SHA256) != 64 {
		t.Fatalf("photo pin = %+v, %v", pin, ok)
	}
	if _, ok := CPUPin("nope"); ok {
		t.Fatal("unknown preset has a pin")
	}
	dir := t.TempDir()
	m := &Module{modelsDir: dir}
	if m.ModelPresent(PhotoPreset) {
		t.Fatal("present before download")
	}
	if err := os.MkdirAll(CPUModelDir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(CPUModelDir(dir), pin.File)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !m.ModelPresent(PhotoPreset) {
		t.Fatal("not present after write")
	}
	if err := m.RemoveModel(PhotoPreset); err != nil || m.ModelPresent(PhotoPreset) {
		t.Fatalf("remove: %v", err)
	}
	if err := m.FetchModel(t.Context(), nil, string(ModelIllustration)); err == nil {
		t.Fatal("fetching the anime model must be refused")
	}
}
