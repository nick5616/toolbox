// Package pdf is the PDF Toolkit: pdfcpu for structural operations, go-pdfium
// (WebAssembly, no filesystem mounts) for rendering, and in-house JPEG
// recompression for Compress. See Phase 4 SPEC.md §6.
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; WP-PDF1 implements the rest (run.go, info.go, render.go, compress.go,
// secrets.go, …). Exported signatures are frozen.
package pdf

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
)

// ModuleID is the PDF Toolkit module ID (same as the Phase 1 placeholder).
const ModuleID = "pdf"

// ImageExtensions are the images accepted by images → PDF.
var ImageExtensions = []string{".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}

// Accepts lists the input extensions (PDFs plus images for images → PDF).
func Accepts() []string { return slices.Concat([]string{".pdf"}, ImageExtensions) }

// Module implements core.Module and owns the shared renderer and the
// in-memory password store.
type Module struct {
	cacheDir string // <support>/cache/pdfium (wazero compilation cache)
	state    *state // implemented by WP-PDF1
}

// New builds the module. cacheDir holds the WebAssembly compilation cache.
func New(cacheDir string) *Module { return &Module{cacheDir: cacheDir, state: newState(cacheDir)} }

// Register adds the module to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Close releases the renderer (call at app quit).
func (m *Module) Close() { m.state.close() }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "PDF Toolkit", Icon: "file-text", Category: core.CategoryDocument,
		Tagline:     "Merge, split and compress PDFs",
		Description: "Everyday PDF operations without uploading documents anywhere.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{},
		Order:       190, OutputSubdir: "PDF",
		SplitInputs: false, MaxConcurrent: 2, MaxInputs: 500,
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
