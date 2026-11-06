// Package scenes finds the shots of a video with FFmpeg's scene detection and
// writes a clip and/or a still for each (Phase 15, "Scene Splitter").
package scenes

import (
	"context"

	"toolbox/core"
)

// ModuleID is the Scene Splitter's module ID.
const ModuleID = "scenes"

// Module implements core.Module.
type Module struct{}

// Register adds the module to the registry.
func Register(reg *core.Registry) error { return reg.Register(&Module{}) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Scene Splitter", Icon: "clapperboard", Category: core.CategoryMedia,
		Tagline:     "Cut a video into its shots",
		Description: "Finds where the picture changes, then saves each scene as its own clip and/or a still. Can keep just the longest or most active scenes.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Order:       138, OutputSubdir: "Scenes",
		SplitInputs: true, MaxInputs: 100,
	}
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }
