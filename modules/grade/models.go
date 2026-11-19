package grade

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// The depth model (Phase 21 SPEC §E5; spike 2026-11-19 in DECISIONS):
// Depth Anything V2 Small (Apache-2.0), the ONNX Community export, fp32
// (fp16 was 1.5× slower on CPU for a 0.004 mean difference).

// DepthPreset is the pack component's preset name.
const DepthPreset = "depth-v2s"

type modelSpec struct {
	File, URL, SHA256, Label string
	Bytes                    int64
}

var depthModel = modelSpec{
	File:   "depth-anything-v2-small.onnx",
	URL:    "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx",
	SHA256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
	Label:  "Depth Anything V2 Small",
	Bytes:  99_060_839,
}

// Inference sizes (short side, a multiple of 14).
const (
	DepthImageShort = 518
	DepthVideoShort = 266 // ≈ 0.3 s/frame on CPU; video also infers every 2nd frame above 15 fps
)

var _ core.ModelProvider = (*Module)(nil)

func (m *Module) depthDir() string { return filepath.Join(m.cfg.ModelsDir, "depth") }

// DepthModelPath is the depth model file ("" without a models dir).
func (m *Module) DepthModelPath() string {
	if m.cfg.ModelsDir == "" {
		return ""
	}
	return filepath.Join(m.depthDir(), depthModel.File)
}

// ModelPresent implements core.ModelProvider.
func (m *Module) ModelPresent(preset string) bool {
	if preset != DepthPreset || m.cfg.ModelsDir == "" {
		return false
	}
	fi, err := os.Stat(m.DepthModelPath())
	return err == nil && fi.Mode().IsRegular()
}

// FetchModel implements core.ModelProvider through depth.prefetch.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	if preset != DepthPreset {
		return core.ValidationError("Unknown depth model", map[string]string{"preset": preset})
	}
	if m.ModelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	if m.cfg.Caller == nil {
		return core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	_, err := m.cfg.Caller.Call(ctx, "depth.prefetch", map[string]any{
		"model":    map[string]any{"file": depthModel.File, "sha256": depthModel.SHA256, "url": depthModel.URL},
		"modelDir": m.depthDir(),
	}, func(ev sidecar.Event) {
		if ev.Kind == "progress" {
			job.Progress(ev.Pct, "Downloading the depth model")
		}
	})
	return err
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error {
	if preset != DepthPreset || m.cfg.ModelsDir == "" {
		return nil
	}
	if err := os.Remove(m.DepthModelPath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing the depth model: %w", err)
	}
	return nil
}
