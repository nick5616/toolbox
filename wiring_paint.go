package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"toolbox/modules/bgremove"
	"toolbox/modules/editstudio"
	"toolbox/modules/eraser"
	"toolbox/modules/paint"
	"toolbox/modules/upscale"
)

// paintModels implements paint.ModelResolver over the modules that own the
// perception models (Phase 19, SPEC.md §2.5). It only looks at what is
// installed; nothing here downloads. Each method returns the engine params
// of the model, which ai.go merges into the call:
//
//	Inpaint  {"model": "best"|"fast", "modelPath"}   (the model actually used)
//	Cutout   {"model": {"file","kind"}, "modelDir"}
//	Segment  {"modelPath"}
//	Enhance  {"model": {"file"}, "modelDir"}          (Real-ESRGAN x4plus only)
type paintModels struct {
	modelsDir string
	eraser    *eraser.Module
	matte     *editstudio.Module
}

var _ paint.ModelResolver = paintModels{}

func newPaintModels(modelsDir string, e *eraser.Module, m *editstudio.Module) paintModels {
	return paintModels{modelsDir: modelsDir, eraser: e, matte: m}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func installed(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// Inpaint: LaMa ("best") and MI-GAN ("fast") from <models>/eraser. When the
// wanted one is missing the other is used, and the answer names the one used.
func (p paintModels) Inpaint(model string) (json.RawMessage, bool) {
	order := []string{"best", "fast"}
	if model == "fast" {
		order = []string{"fast", "best"}
	}
	for _, id := range order {
		if path, ok := p.eraser.ModelPath(id); ok {
			return mustJSON(map[string]any{"model": id, "modelPath": path}), true
		}
	}
	return nil, false
}

// Cutout: the background-removal presets in <models>/bg. BiRefNet presets
// (balanced, best) stand in for each other; IS-Net ("fast") is only used when
// asked for, and a "fast" request falls back to BiRefNet.
func (p paintModels) Cutout(model string) (json.RawMessage, bool) {
	order := map[string][]string{
		"fast":     {"fast", "balanced", "best"},
		"balanced": {"balanced", "best"},
		"best":     {"best", "balanced"},
	}[model]
	dir := bgremove.ModelDir(p.modelsDir)
	for _, id := range order {
		spec, ok := bgremove.SpecFor(id)
		if ok && installed(filepath.Join(dir, spec.File)) {
			return mustJSON(map[string]any{
				"model":    map[string]any{"file": spec.File, "kind": spec.Kind},
				"modelDir": dir,
			}), true
		}
	}
	return nil, false
}

// Segment: SAM 2.1 tiny from <models>/matte (Edit Studio's "select" model).
func (p paintModels) Segment() (json.RawMessage, bool) {
	path, ok := p.matte.ModelPath(editstudio.PresetSelect)
	if !ok {
		return nil, false
	}
	return mustJSON(map[string]any{"modelPath": path}), true
}

// Enhance: the Real-ESRGAN x4plus CPU model from <models>/upscale. Only the
// photo preset exists here; the anime models are never offered.
func (p paintModels) Enhance(preset string) (json.RawMessage, bool) {
	if preset != "" && preset != upscale.PhotoPreset {
		return nil, false
	}
	pin, ok := upscale.CPUPin(upscale.PhotoPreset)
	dir := upscale.CPUModelDir(p.modelsDir)
	if !ok || !installed(filepath.Join(dir, pin.File)) {
		return nil, false
	}
	return mustJSON(map[string]any{"model": map[string]any{"file": pin.File}, "modelDir": dir}), true
}
