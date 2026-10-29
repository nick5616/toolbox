// Package subtitles generates, edits, translates, embeds and burns in
// subtitles (SPEC.md §5).
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; SB1 implements impl.go (and any new files). Exported signatures are
// frozen.
package subtitles

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

// ModuleID is the Subtitles module ID.
const ModuleID = "subtitles"

// Module implements core.Module.
type Module struct {
	sc        sidecar.Caller                     // transcribe.run for generate
	tg        core.TextGenerator                 // translate
	resolve   func(depID string) (string, error) // ffmpeg/ffprobe for Validate
	modelsDir string                             // Whisper models in <modelsDir>/whisper/
}

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, tg core.TextGenerator, resolve func(string) (string, error), modelsDir string) (*Module, error) {
	m := &Module{sc: sc, tg: tg, resolve: resolve, modelsDir: modelsDir}
	return m, reg.Register(m)
}

// Accepts lists the input extensions.
func Accepts() []string {
	return append(append(media.VideoExtensions(), media.AudioExtensions()...), ".srt", ".vtt")
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Subtitles", Icon: "captions", Category: core.CategoryMedia,
		Tagline:     "Generate, translate and burn in subtitles",
		Description: "Make subtitles from speech, edit them against the video, translate them locally, and add them as a track or burn them in.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Recommends:  []string{sidecar.DepID},
		Order:       172, OutputSubdir: "Subtitles",
		MaxInputs: 1,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }
