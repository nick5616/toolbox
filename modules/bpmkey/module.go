// Package bpmkey is the BPM & Key module (librosa via the audio engine).
// See SPEC.md §6.2.
//
// CONTRACT STUB (foundation): options.go and service.go are final; WP-M1
// implements Validate and Run. Exported signatures are frozen.
package bpmkey

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ModuleID is the BPM & Key module ID.
const ModuleID = "bpm-key"

// Module implements core.Module.
type Module struct{ sc sidecar.Caller }

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller) error { return reg.Register(&Module{sc: sc}) }

// Accepts lists the input extensions.
func Accepts() []string { return slices.Concat(core.AudioExtensions, core.VideoExtensions) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "BPM & Key", Icon: "activity", Category: core.CategoryAudio,
		Tagline:     "Detect tempo and musical key",
		Description: "Analyse audio files for tempo and key, with Camelot notation for harmonic mixing.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID},
		Order:       110, SplitInputs: true, MaxInputs: 100,
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
