// Package visualizer makes reactive visuals for songs, lyrics and videos
// (SPEC.md Phase 7). The analysis and render machinery lives in core/viz,
// shared with Lyric Video and Subtitles.
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; VM1 implements impl.go (and any new files) and models.go's fetch.
// Exported signatures are frozen.
package visualizer

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// ModuleID is the Visualizer's module ID.
const ModuleID = "visualizer"

// Module implements core.Module and core.ModelProvider (the mood reader).
type Module struct {
	an         *viz.Analyzer
	br         *viz.RenderBroker
	sc         sidecar.Caller
	textgen    core.TextGenerator
	resolve    func(depID string) (string, error)
	modelsDir  string // the mood reader lives in <modelsDir>/mood/
	previewDir string // <support>/cache/visualizer (previews)
}

var _ core.ModelProvider = (*Module)(nil)

// Register adds the module to the registry and points the analyzer at the
// mood reader's files.
func Register(reg *core.Registry, an *viz.Analyzer, br *viz.RenderBroker, sc sidecar.Caller, textgen core.TextGenerator,
	resolve func(string) (string, error), modelsDir, previewDir string) (*Module, error) {
	m := &Module{an: an, br: br, sc: sc, textgen: textgen, resolve: resolve, modelsDir: modelsDir, previewDir: previewDir}
	an.MoodModel = m.moodModel
	return m, reg.Register(m)
}

// Accepts lists the input extensions.
func Accepts() []string { return slices.Concat(media.AudioExtensions(), media.VideoExtensions()) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Visualizer", Icon: "sparkles", Category: core.CategoryAudio,
		Tagline:     "Visuals that react to the music and the words",
		Description: "Turn a song or video into reactive visuals that follow the instruments, beat, sections, chords and the mood of the words.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID, "ffmpeg", "ffprobe"},
		Order:       110, OutputSubdir: "Visualizer",
		MaxInputs: 1,
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

// PrunePreviews deletes previews older than a day (called at start).
func (m *Module) PrunePreviews() { m.prunePreviews() }
