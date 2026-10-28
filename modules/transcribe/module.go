// Package transcribe is Transcribe (faster-whisper via the audio engine).
// See Phase 3 SPEC.md §5.
//
// CONTRACT STUB (foundation): options.go, presets.go, module.go and
// service.go are final; WP-TR1 implements run.go. Exported signatures are
// frozen.
package transcribe

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ModuleID is the Transcribe module ID.
const ModuleID = "transcribe"

// Module implements core.Module.
type Module struct {
	sc        sidecar.Caller
	modelsDir string // <support>/models; whisper models go in <modelsDir>/whisper/<model>
}

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, modelsDir string) error {
	return reg.Register(&Module{sc: sc, modelsDir: modelsDir})
}

// Accepts lists the input extensions.
func Accepts() []string { return slices.Concat(core.AudioExtensions, core.VideoExtensions) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Transcribe", Icon: "captions", Category: core.CategoryAI,
		Tagline:     "Speech to text, fully offline",
		Description: "Transcribe audio and video locally with Whisper, exporting text and subtitles.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID},
		Order:       170, OutputSubdir: "Transcripts",
		SplitInputs: true, MaxConcurrent: 1, MaxInputs: 100,
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
