// Package bgremove is the Background Remover (ONNX models in the AI engine).
// See Phase 4 SPEC.md §4 and §13.1.
//
// CONTRACT STUB (foundation): options.go, presets.go, module.go and
// service.go are final; WP-BG1 implements run.go. Exported signatures are
// frozen.
package bgremove

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ModuleID is the Background Remover module ID (same as the Phase 1 placeholder).
const ModuleID = "bg-remover"

// Module implements core.Module.
type Module struct {
	sc        sidecar.Caller
	modelsDir string // <support>/models; models go in <modelsDir>/bg/<file>
}

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, modelsDir string) error {
	return reg.Register(&Module{sc: sc, modelsDir: modelsDir})
}

// Accepts lists the input extensions (HEIC/HEIF via pillow-heif in the engine).
func Accepts() []string {
	return []string{".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Background Remover", Icon: "wand-sparkles", Category: core.CategoryImage,
		Tagline:     "Cut subjects out of photos",
		Description: "Remove image backgrounds locally, leaving a clean transparent PNG.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID},
		Order:       140, OutputSubdir: "Cutouts",
		SplitInputs: true, MaxConcurrent: 1, MaxInputs: 200,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return m.run(ctx, job)
}
