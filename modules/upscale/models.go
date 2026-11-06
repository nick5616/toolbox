package upscale

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// PhotoPreset is the only preset Paint+'s Enhance uses (Real-ESRGAN x4plus,
// trained on photographs; never the anime models).
const PhotoPreset = string(ModelPhoto)

// CPUModelPin is a pinned CPU model file.
type CPUModelPin struct {
	File   string
	SHA256 string
	URL    string
	Bytes  int64
}

// CPUPin returns the pinned CPU model of a preset.
func CPUPin(preset string) (CPUModelPin, bool) {
	m, ok := models[Model(preset)]
	if !ok {
		return CPUModelPin{}, false
	}
	return CPUModelPin{File: m.CPU.File, SHA256: m.CPU.SHA256, URL: m.CPU.URL, Bytes: m.CPU.DownloadBytes}, true
}

// CPUModelDir is where the CPU models live under the models folder.
func CPUModelDir(modelsDir string) string { return filepath.Join(modelsDir, "upscale") }

var _ core.ModelProvider = (*Module)(nil)

// ModelPresent implements core.ModelProvider for the CPU model files.
func (m *Module) ModelPresent(preset string) bool {
	pin, ok := CPUPin(preset)
	if !ok || m.modelsDir == "" {
		return false
	}
	fi, err := os.Stat(filepath.Join(CPUModelDir(m.modelsDir), pin.File))
	return err == nil && fi.Mode().IsRegular()
}

// FetchModel implements core.ModelProvider: only the photo model, through the
// engine's paint.prefetch (sha256-verified), when the user asks for it.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	if preset != PhotoPreset {
		return core.ValidationError("Only the photo upscaling model can be downloaded here", map[string]string{"preset": preset})
	}
	if m.ModelPresent(preset) {
		return nil
	}
	pin, _ := CPUPin(preset)
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	_, err := m.sc.Call(ctx, "paint.prefetch", map[string]any{
		"model":    map[string]any{"file": pin.File, "sha256": pin.SHA256, "url": pin.URL},
		"modelDir": CPUModelDir(m.modelsDir),
	}, func(ev sidecar.Event) {
		if ev.Kind == "progress" {
			job.Progress(ev.Pct, ev.Msg)
		}
	})
	return err
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error {
	pin, ok := CPUPin(preset)
	if !ok || m.modelsDir == "" {
		return nil
	}
	if err := os.Remove(filepath.Join(CPUModelDir(m.modelsDir), pin.File)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing the %s upscaling model: %w", preset, err)
	}
	return nil
}
