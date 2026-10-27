// Package stems is the Stem Splitter module (audio-separator via the audio
// engine). See SPEC.md §6.1.
//
// CONTRACT STUB (foundation): options.go, presets.go and service.go are final;
// WP-M1 implements Validate and Run. Exported signatures are frozen.
package stems

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ModuleID is the Stem Splitter's module ID.
const ModuleID = "stems"

// Module implements core.Module.
type Module struct{ sc sidecar.Caller }

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller) error { return reg.Register(&Module{sc: sc}) }

// Accepts lists the input extensions.
func Accepts() []string { return slices.Concat(core.AudioExtensions, core.VideoExtensions) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Stem Splitter", Icon: "audio-lines", Category: core.CategoryAudio,
		Tagline:      "Split a song into vocals, drums, bass and more",
		Description:  "Separate any track into individual stems using local machine-learning models.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: Accepts()},
		Requires:     []string{sidecar.DepID},
		OutputSubdir: "Stems", Order: 100,
		SplitInputs: true, MaxConcurrent: 1, MaxInputs: 100,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return core.NotImplemented("stems.Validate")
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("stems.Run")
}
