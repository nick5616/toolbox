// Package lyricvideo times lyrics to a song and renders a lyric video
// (SPEC.md §7).
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; LV1 implements impl.go (and any new files). Exported signatures are
// frozen.
package lyricvideo

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// ModuleID is Lyric Video's module ID.
const ModuleID = "lyric-video"

// Module implements core.Module.
type Module struct {
	sc        sidecar.Caller // stems.run, transcribe.run
	resolve   func(depID string) (string, error)
	modelsDir string            // Whisper models in <modelsDir>/whisper/
	cacheDir  string            // <support>/cache/lyric-video
	an        *viz.Analyzer     // visual backgrounds (SPEC.md §9.2)
	br        *viz.RenderBroker //
}

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, resolve func(string) (string, error), modelsDir, cacheDir string) (*Module, error) {
	m := &Module{sc: sc, resolve: resolve, modelsDir: modelsDir, cacheDir: cacheDir}
	return m, reg.Register(m)
}

// Accepts lists the input extensions.
func Accepts() []string { return media.AudioExtensions() }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Lyric Video", Icon: "mic-vocal", Category: core.CategoryAudio,
		Tagline:     "Turn a song into a lyric video",
		Description: "Time lyrics to a song (detected, pasted or from a file) and render a karaoke-style lyric video.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Recommends:  []string{sidecar.DepID},
		Order:       115, OutputSubdir: "Lyric videos",
		MaxInputs: 1,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }

// SetVisuals gives the module the Visualizer's analyzer and render broker.
func (m *Module) SetVisuals(an *viz.Analyzer, br *viz.RenderBroker) { m.an, m.br = an, br }

// PruneCache deletes cached stems folders untouched for 7 days and stale
// previews (called at start).
func (m *Module) PruneCache() { m.pruneCache() }
