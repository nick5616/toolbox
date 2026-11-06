package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/modules/bgremove"
	"toolbox/modules/editstudio"
	"toolbox/modules/eraser"
	"toolbox/modules/upscale"
)

func touchModel(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func decode(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPaintModelResolver(t *testing.T) {
	models := t.TempDir()
	em, err := eraser.Register(core.NewRegistry(), nil, models, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := newPaintModels(models, em, editstudio.New(editstudio.Config{ModelsDir: models}))

	for name, f := range map[string]func() (json.RawMessage, bool){
		"inpaint": func() (json.RawMessage, bool) { return p.Inpaint("best") },
		"cutout":  func() (json.RawMessage, bool) { return p.Cutout("fast") },
		"segment": p.Segment,
		"enhance": func() (json.RawMessage, bool) { return p.Enhance("") },
	} {
		if _, ok := f(); ok {
			t.Fatalf("%s reported installed in an empty models dir", name)
		}
	}

	// Inpaint falls back to the other model and names the one it used.
	touchModel(t, filepath.Join(models, "eraser"), "migan_pipeline_v2.onnx")
	raw, ok := p.Inpaint("best")
	if m := decode(t, raw); !ok || m["model"] != "fast" || filepath.Base(m["modelPath"].(string)) != "migan_pipeline_v2.onnx" {
		t.Fatalf("inpaint(best) with only MI-GAN = %v, %v", m, ok)
	}
	touchModel(t, filepath.Join(models, "eraser"), "lama_fp32.onnx")
	if m := decode(t, mustRaw(p.Inpaint("best"))); m["model"] != "best" {
		t.Fatalf("inpaint(best) = %v", m)
	}
	if m := decode(t, mustRaw(p.Inpaint("fast"))); m["model"] != "fast" {
		t.Fatalf("inpaint(fast) = %v", m)
	}

	// Cutout: IS-Net never stands in for a BiRefNet request.
	fast, _ := bgremove.SpecFor("fast")
	bal, _ := bgremove.SpecFor("balanced")
	touchModel(t, bgremove.ModelDir(models), fast.File)
	if _, ok := p.Cutout("balanced"); ok {
		t.Fatal("balanced resolved to IS-Net")
	}
	if m := decode(t, mustRaw(p.Cutout("fast"))); m["model"].(map[string]any)["kind"] != "isnet" {
		t.Fatalf("cutout(fast) = %v", m)
	}
	touchModel(t, bgremove.ModelDir(models), bal.File)
	m := decode(t, mustRaw(p.Cutout("best")))
	if mm := m["model"].(map[string]any); mm["file"] != bal.File || mm["kind"] != "birefnet" || m["modelDir"] != bgremove.ModelDir(models) {
		t.Fatalf("cutout(best) fallback = %v", m)
	}
	if _, ok := p.Cutout("bogus"); ok {
		t.Fatal("unknown preset resolved")
	}

	// Segment: Edit Studio's SAM 2.1 tiny.
	touchModel(t, filepath.Join(models, "matte"), "sam2.1_hiera_tiny.pt")
	if m := decode(t, mustRaw(p.Segment())); filepath.Base(m["modelPath"].(string)) != "sam2.1_hiera_tiny.pt" {
		t.Fatalf("segment = %v", m)
	}

	// Enhance: x4plus only.
	pin, _ := upscale.CPUPin(upscale.PhotoPreset)
	touchModel(t, upscale.CPUModelDir(models), pin.File)
	if _, ok := p.Enhance("illustration"); ok {
		t.Fatal("the anime preset must never resolve")
	}
	if _, ok := p.Enhance("fast"); ok {
		t.Fatal("only the photo preset resolves")
	}
	for _, preset := range []string{"", "photo"} {
		m := decode(t, mustRaw(p.Enhance(preset)))
		if m["model"].(map[string]any)["file"] != "RealESRGAN_x4plus.pth" {
			t.Fatalf("enhance(%q) = %v", preset, m)
		}
	}
}

func mustRaw(raw json.RawMessage, ok bool) json.RawMessage {
	if !ok {
		panic("model not resolved")
	}
	return raw
}
