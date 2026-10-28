// Package upscale is the Upscaler: Real-ESRGAN on the GPU via the managed
// upscayl-bin, with a CPU fallback in the AI engine. See Phase 4 SPEC.md §5
// and §13.
//
// CONTRACT STUB (foundation): options.go, presets.go, module.go and
// service.go are final; WP-UP1 implements run.go. Exported signatures are
// frozen.
package upscale

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/sidecar"
)

// ModuleID is the Upscaler module ID (same as the Phase 1 placeholder).
const ModuleID = "upscaler"

// Module implements core.Module.
type Module struct {
	sc        sidecar.Caller
	modelsDir string // <support>/models; CPU models go in <modelsDir>/upscale/<file>
}

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, modelsDir string) error {
	return reg.Register(&Module{sc: sc, modelsDir: modelsDir})
}

// Accepts lists the input extensions (HEIC/HEIF are converted by the engine first).
func Accepts() []string { return []string{".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"} }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Upscaler", Icon: "maximize-2", Category: core.CategoryImage,
		Tagline:     "Enlarge images without the blur",
		Description: "Upscale images 2× or 4× with Real-ESRGAN running on your machine.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{deps.Upscayl},
		Order:       150, OutputSubdir: "Upscaled",
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
