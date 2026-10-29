package eraser

// Pinned inpainting models (SPEC.md §0.4), verified by sha256 in the engine.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

type modelSpec struct {
	Label         string
	File          string
	SHA256        string
	URL           string
	DownloadBytes int64
}

var models = map[Model]modelSpec{
	ModelBest: {"Best", "lama_fp32.onnx",
		"1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
		"https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
		208_044_816},
	ModelFast: {"Fast", "migan_pipeline_v2.onnx",
		"6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b",
		"https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx",
		28_079_181},
}

var modelOrder = []Model{ModelBest, ModelFast}

func (m *Module) modelDir() string { return filepath.Join(m.modelsDir, "eraser") }

func (m *Module) modelFile(spec modelSpec) string { return filepath.Join(m.modelDir(), spec.File) }

func (m *Module) modelPresent(preset string) bool {
	spec, ok := models[Model(preset)]
	if !ok || m.modelsDir == "" {
		return false
	}
	fi, err := os.Stat(m.modelFile(spec))
	return err == nil && fi.Mode().IsRegular()
}

func (m *Module) fetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	spec, ok := models[Model(preset)]
	if !ok {
		return core.ValidationError("Unknown erasing model", map[string]string{"preset": preset})
	}
	if m.modelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	sink := &eventSink{job: job, seen: map[string]bool{}}
	_, err := m.sc.Call(ctx, "eraser.prefetch", map[string]any{
		"model":    map[string]any{"file": spec.File, "sha256": spec.SHA256, "url": spec.URL},
		"modelDir": m.modelDir(),
	}, sink.onEvent)
	return err
}

func (m *Module) removeModel(preset string) error {
	spec, ok := models[Model(preset)]
	if !ok || m.modelsDir == "" {
		return nil
	}
	if err := os.Remove(m.modelFile(spec)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing the %s erasing model: %w", spec.Label, err)
	}
	return nil
}

func (m *Module) modelStatus() []ModelInfo {
	out := make([]ModelInfo, 0, len(modelOrder))
	for _, id := range modelOrder {
		spec := models[id]
		out = append(out, ModelInfo{ID: id, Label: spec.Label, DownloadBytes: spec.DownloadBytes, Present: m.modelPresent(string(id))})
	}
	return out
}
