package editstudio

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/modules/bgremove"
)

// Cut-out models (SPEC.md §10.6). The pins were measured in Wave 0; the files live in
// <models>/matte/ and are downloaded by the engine's matte.prefetch (sha256-verified).
// Run handlers never download; photo cut-outs use Background Remover's "balanced" model
// (<models>/bg/).

// Module is a core.ModelProvider for the presets "people" and "select".
var _ core.ModelProvider = (*Module)(nil)

// modelSpec is one pinned model file.
type modelSpec struct {
	Label  string
	File   string
	URL    string
	SHA256 string
	Bytes  int64
}

// Model presets.
const (
	PresetPeople = "people"
	PresetSelect = "select"
)

var matteModelPins = map[string]modelSpec{
	PresetPeople: {
		Label: "People cut-out (Robust Video Matting)", File: "rvm_mobilenetv3_fp32.onnx",
		URL:    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx",
		SHA256: "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828", Bytes: 14_975_696,
	},
	PresetSelect: {
		Label: "Subject select (SAM 2.1 tiny)", File: "sam2.1_hiera_tiny.pt",
		URL:    "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
		SHA256: "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69", Bytes: 156_008_466,
	},
}

// matteModelDir is <models>/matte.
func (m *Module) matteModelDir() string { return filepath.Join(m.cfg.ModelsDir, "matte") }

func (m *Module) matteModelPath(preset string) string {
	return filepath.Join(m.matteModelDir(), matteModelPins[preset].File)
}

func regularFile(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// ModelPresent implements core.ModelProvider.
func (m *Module) ModelPresent(preset string) bool {
	if _, ok := matteModelPins[preset]; !ok || m.cfg.ModelsDir == "" {
		return false
	}
	return regularFile(m.matteModelPath(preset))
}

// FetchModel implements core.ModelProvider via the engine's matte.prefetch.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	spec, ok := matteModelPins[preset]
	if !ok {
		return core.ValidationError("Unknown cut-out model", map[string]string{"preset": preset})
	}
	if m.ModelPresent(preset) {
		return nil
	}
	if m.cfg.Engine == nil {
		return core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	sink := &matteSink{job: job, span: 1}
	_, err := m.cfg.Engine.Call(ctx, "matte.prefetch", map[string]any{
		"model":    map[string]any{"file": spec.File, "sha256": spec.SHA256, "url": spec.URL},
		"modelDir": m.matteModelDir(),
	}, sink.onEvent)
	return err
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error {
	spec, ok := matteModelPins[preset]
	if !ok || m.cfg.ModelsDir == "" {
		return nil
	}
	if err := os.Remove(m.matteModelPath(preset)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing the %s model: %w", spec.Label, err)
	}
	return nil
}

// imageModelPresent reports Background Remover's balanced model (photo cut-outs).
func (m *Module) imageModelPresent() bool {
	spec, ok := bgremove.SpecFor("balanced")
	if !ok || m.cfg.ModelsDir == "" {
		return false
	}
	return regularFile(filepath.Join(bgremove.ModelDir(m.cfg.ModelsDir), spec.File))
}

// matteModels reports which cut-out models are installed. SelectAvailable stays true: the engine
// answers "unavailable" itself where SAM 2 can't run (§10.4).
func (m *Module) matteModels() MatteModels {
	return MatteModels{
		People: m.ModelPresent(PresetPeople), Select: m.ModelPresent(PresetSelect),
		Image: m.imageModelPresent(), SelectAvailable: true,
	}
}
