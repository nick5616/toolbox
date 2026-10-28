// Package exif is the EXIF tool: inspect metadata, strip location / all
// metadata, edit common fields — always into new files. See Phase 3
// SPEC.md §6.
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; WP-EX1 implements run.go and session.go (and adds files/tests).
// Exported signatures are frozen.
package exif

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/deps"
)

// ModuleID is the EXIF module ID.
const ModuleID = "exif"

// RawExtensions are camera RAW formats: readable, never written.
var RawExtensions = []string{".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2"}

// Accepts lists the input extensions.
func Accepts() []string { return slices.Concat(core.ImageExtensions, RawExtensions) }

// Module implements core.Module and owns the shared ExifTool session.
type Module struct {
	resolve func(depID string) (string, error)
	sess    *session
}

// New builds the module. resolve finds the exiftool executable (deps.Service.Resolve).
func New(resolve func(depID string) (string, error)) *Module {
	return &Module{resolve: resolve, sess: newSession(func() (string, error) { return resolve(deps.ExifTool) })}
}

// Register adds m to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Close stops the ExifTool session (app shutdown).
func (m *Module) Close() { m.sess.Close() }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "EXIF", Icon: "scan-search", Category: core.CategoryImage,
		Tagline:     "View, edit or strip photo metadata",
		Description: "Inspect camera metadata, edit fields, or strip location and personal data before sharing.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{deps.ExifTool},
		Order:       160, OutputSubdir: "Metadata",
		SplitInputs: true, MaxInputs: 100,
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

// Read returns a file's metadata (direct call, not a job).
func (m *Module) Read(ctx context.Context, path string) (MetadataView, error) {
	return m.read(ctx, path)
}
