// Package midi is the Audio → MIDI module (Basic Pitch ONNX via the audio
// engine). See SPEC.md §6.3.
//
// CONTRACT STUB (foundation): options.go and service.go are final; WP-M1
// implements Validate and Run. Exported signatures are frozen.
package midi

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ModuleID is the Audio → MIDI module ID.
const ModuleID = "audio-to-midi"

// Module implements core.Module.
type Module struct{ sc sidecar.Caller }

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller) error { return reg.Register(&Module{sc: sc}) }

// Accepts lists the input extensions.
func Accepts() []string { return slices.Concat(core.AudioExtensions, core.VideoExtensions) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Audio → MIDI", Icon: "piano", Category: core.CategoryAudio,
		Tagline:      "Transcribe melodies and chords into MIDI",
		Description:  "Turn recorded melodies and chords into editable MIDI clips with Spotify's Basic Pitch model.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: Accepts()},
		Requires:     []string{sidecar.DepID},
		OutputSubdir: "MIDI", Order: 120, SplitInputs: true, MaxInputs: 100,
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
