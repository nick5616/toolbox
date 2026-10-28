package bgremove

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// Module is a core.ModelProvider (SPEC.md §7.8).
var _ core.ModelProvider = (*Module)(nil)

func (m *Module) modelPath(spec modelSpec) string {
	return filepath.Join(m.modelsDir, "bg", spec.File)
}

// ModelPresent implements core.ModelProvider: the ONNX file is in <models>/bg/.
func (m *Module) ModelPresent(preset string) bool {
	spec, ok := models[Model(preset)]
	if !ok || m.modelsDir == "" {
		return false
	}
	fi, err := os.Stat(m.modelPath(spec))
	return err == nil && fi.Mode().IsRegular()
}

// FetchModel implements core.ModelProvider via the engine's bgremove.prefetch
// (the same sha-verified download bgremove.run uses).
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	spec, ok := models[Model(preset)]
	if !ok {
		return core.ValidationError("Unknown background-removal model", map[string]string{"preset": preset})
	}
	if m.ModelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	sink := &eventSink{job: job, seen: map[string]bool{}}
	_, err := m.sc.Call(ctx, "bgremove.prefetch", map[string]any{
		"model": map[string]any{
			"file": spec.File, "sha256": spec.SHA256, "url": spec.URL, "kind": string(spec.Kind),
		},
		"modelDir": filepath.Join(m.modelsDir, "bg"),
	}, sink.onEvent)
	return err
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error {
	spec, ok := models[Model(preset)]
	if !ok || m.modelsDir == "" {
		return nil
	}
	if err := os.Remove(m.modelPath(spec)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing the %s model: %w", spec.Label, err)
	}
	return nil
}
