// Package audiocleanup removes rumble, hum and noise and normalises loudness
// (SPEC.md §6).
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; AC1 implements impl.go and models.go (and any new files). Exported
// signatures are frozen.
package audiocleanup

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

// ModuleID is Audio Cleanup's module ID.
const ModuleID = "audio-cleanup"

// PresetVoice is the DeepFilterNet3 model preset (core.ModelProvider).
const PresetVoice = "voice"

// Module implements core.Module and core.ModelProvider.
type Module struct {
	sc         sidecar.Caller
	resolve    func(depID string) (string, error)
	modelsDir  string // DeepFilterNet3 in <modelsDir>/denoise/dfn3/
	previewDir string // <support>/cache/cleanup-preview
}

var _ core.ModelProvider = (*Module)(nil)

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, resolve func(string) (string, error), modelsDir, previewDir string) (*Module, error) {
	m := &Module{sc: sc, resolve: resolve, modelsDir: modelsDir, previewDir: previewDir}
	return m, reg.Register(m)
}

// Accepts lists the input extensions.
func Accepts() []string { return append(media.AudioExtensions(), media.VideoExtensions()...) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Audio Cleanup", Icon: "audio-waveform", Category: core.CategoryAudio,
		Tagline:     "Remove noise and hum, fix loudness",
		Description: "Clean up voice recordings and the audio of videos: rumble, mains hum, background noise and loudness.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Recommends:  []string{sidecar.DepID},
		Order:       125, OutputSubdir: "Cleaned audio",
		SplitInputs: true, MaxInputs: 50,
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

// PrunePreviews deletes preview excerpts older than a day (called at start).
func (m *Module) PrunePreviews() { m.prunePreviews() }
