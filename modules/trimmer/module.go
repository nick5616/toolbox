// Package trimmer cuts ranges out of video and audio files with FFmpeg
// (SPEC.md §4).
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; TR1 implements validate.go and run.go (and any new files).
// Exported signatures are frozen.
package trimmer

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/media"
)

// ModuleID is the Video Trimmer's module ID.
const ModuleID = "trimmer"

// Module implements core.Module.
type Module struct {
	// resolve finds ffmpeg/ffprobe (deps.Service.Resolve); Validate probes
	// the input with it.
	resolve func(depID string) (string, error)
}

// Register adds the module to the registry.
func Register(reg *core.Registry, resolve func(depID string) (string, error)) error {
	return reg.Register(&Module{resolve: resolve})
}

// Accepts lists the input extensions.
func Accepts() []string { return append(media.VideoExtensions(), media.AudioExtensions()...) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Video Trimmer", Icon: "scissors", Category: core.CategoryMedia,
		Tagline:     "Cut clips out of videos and songs",
		Description: "Keep one or more ranges of a video or audio file, losslessly or frame-accurately, and reframe for social.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Order:       135, OutputSubdir: "Trimmed",
		MaxInputs: 1,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }
