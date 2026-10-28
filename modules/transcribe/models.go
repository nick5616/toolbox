package transcribe

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

func (m *Module) modelDir(preset Model) string {
	return filepath.Join(m.modelsDir, "whisper", string(preset))
}

// ModelPresent implements core.ModelProvider: <models>/whisper/<preset>/model.bin.
func (m *Module) ModelPresent(preset string) bool {
	if _, ok := models[Model(preset)]; !ok || m.modelsDir == "" {
		return false
	}
	fi, err := os.Stat(filepath.Join(m.modelDir(Model(preset)), "model.bin"))
	return err == nil && fi.Mode().IsRegular()
}

// FetchModel implements core.ModelProvider via the engine's transcribe.prefetch.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	spec, ok := models[Model(preset)]
	if !ok {
		return core.ValidationError("Unknown transcription model", map[string]string{"preset": preset})
	}
	if m.ModelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	sink := newOutputs(job)
	_, err := m.sc.Call(ctx, "transcribe.prefetch", map[string]any{
		"preset": preset, "model": spec.Repo, "modelDir": m.modelDir(Model(preset)),
	}, sink.onEvent)
	return err
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error {
	if _, ok := models[Model(preset)]; !ok || m.modelsDir == "" {
		return nil
	}
	if err := os.RemoveAll(m.modelDir(Model(preset))); err != nil {
		return fmt.Errorf("removing the %s model: %w", preset, err)
	}
	return nil
}
