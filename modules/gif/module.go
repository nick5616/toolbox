// Package gif makes looping GIFs and animated WebPs from a part of a video,
// and contact sheets (a grid of frames with timecodes), with FFmpeg
// (Phase 15, "GIF & Contact Sheet").
package gif

import (
	"context"

	"toolbox/core"
)

// ModuleID is the module's ID.
const ModuleID = "gif"

// Module implements core.Module.
type Module struct{}

// Register adds the module to the registry.
func Register(reg *core.Registry) error { return reg.Register(&Module{}) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "GIF & Contact Sheet", Icon: "images", Category: core.CategoryMedia,
		Tagline:     "Loops and thumbnails from a video",
		Description: "Turns a part of a video into a looping GIF or animated WebP, or lays out evenly spaced frames, with timecodes, on one contact sheet.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Order:       139, OutputSubdir: "GIFs",
		SplitInputs: true, MaxInputs: 100,
	}
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }
