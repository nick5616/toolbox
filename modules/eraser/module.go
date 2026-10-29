// Package eraser removes painted-over objects from photos by inpainting on
// the AI engine (SPEC.md §9). Its module ID is "object-eraser".
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; ER1 implements impl.go and models.go (and any new files). Exported
// signatures are frozen.
package eraser

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

// ModuleID is Object Eraser's module ID.
const ModuleID = "object-eraser"

// Module implements core.Module and core.ModelProvider.
type Module struct {
	sc        sidecar.Caller
	modelsDir string // <modelsDir>/eraser/
	maskDir   string // <support>/tmp/eraser
}

var _ core.ModelProvider = (*Module)(nil)

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, modelsDir, maskDir string) (*Module, error) {
	m := &Module{sc: sc, modelsDir: modelsDir, maskDir: maskDir}
	return m, reg.Register(m)
}

// Accepts lists the input extensions.
func Accepts() []string { return media.ImageExtensions() }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Object Eraser", Icon: "eraser", Category: core.CategoryImage,
		Tagline:     "Paint over something to remove it",
		Description: "Remove people, objects and blemishes from photos; the gap is filled in from the surroundings.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID},
		Order:       145, OutputSubdir: "Erased",
		MaxConcurrent: 1, MaxInputs: 1,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }

// ModelPresent implements core.ModelProvider.
func (m *Module) ModelPresent(preset string) bool { return m.modelPresent(preset) }

// FetchModel implements core.ModelProvider.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	return m.fetchModel(ctx, job, preset)
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error { return m.removeModel(preset) }

// ClearMasks empties the mask folder (called at start).
func (m *Module) ClearMasks() { m.clearMasks() }
