package editstudio

import (
	"context"

	"toolbox/core"
)

// Cut-out models (SPEC.md §10.6). Pins measured in Wave 0; WP-ES7 fills the
// ModelProvider bodies (files in <models>/matte/, downloads via matte.prefetch).

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

// ModelPresent implements core.ModelProvider.
func (m *Module) ModelPresent(preset string) bool { return false }

// FetchModel implements core.ModelProvider.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	return notBuilt("Cut-out models")
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error { return nil }

// matteModels reports which cut-out models are installed.
func (m *Module) matteModels() MatteModels { return MatteModels{} }
