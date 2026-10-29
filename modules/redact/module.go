// Package redact finds faces and number plates in photos and videos and
// blurs, pixelates or blacks them out (SPEC.md §8).
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; RD1 implements impl.go and models.go (and any new files). Exported
// signatures are frozen.
package redact

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

// ModuleID is Redact's module ID.
const ModuleID = "redact"

// Model presets (core.ModelProvider).
const (
	PresetFaces  = "faces"
	PresetPlates = "plates"
)

// Module implements core.Module and core.ModelProvider.
type Module struct {
	sc        sidecar.Caller
	resolve   func(depID string) (string, error)
	modelsDir string // <modelsDir>/redact/
	cacheDir  string // <support>/cache/redact (video detections)
}

var _ core.ModelProvider = (*Module)(nil)

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, resolve func(string) (string, error), modelsDir, cacheDir string) (*Module, error) {
	m := &Module{sc: sc, resolve: resolve, modelsDir: modelsDir, cacheDir: cacheDir}
	return m, reg.Register(m)
}

// Accepts lists the input extensions.
func Accepts() []string { return append(media.ImageExtensions(), media.VideoExtensions()...) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Redact", Icon: "scan-face", Category: core.CategoryImage,
		Tagline:     "Blur faces and number plates",
		Description: "Find faces and number plates in photos and videos, review them, and blur, pixelate or black them out.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID, "ffmpeg", "ffprobe"},
		Order:       155, OutputSubdir: "Redacted",
		MaxConcurrent: 1, MaxInputs: 100,
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

// PruneCache deletes video detection files older than 7 days (called at
// start).
func (m *Module) PruneCache() { m.pruneCache() }
