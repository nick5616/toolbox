// Package converter is the ffmpeg-based Converter module. See SPEC.md §5.
//
// CONTRACT STUB (foundation): options.go, presets.go and service.go are
// final; WP-C1 implements Validate and Run (plus args/progress helpers).
// Exported signatures are frozen.
package converter

import (
	"slices"

	"toolbox/core"
)

// ModuleID is the Converter's module ID.
const ModuleID = "converter"

// Module implements core.Module.
type Module struct{}

// Register adds the module to the registry.
func Register(reg *core.Registry) error { return reg.Register(&Module{}) }

// Accepts lists the input extensions.
func Accepts() []string {
	return slices.Concat(core.AudioExtensions, core.VideoExtensions, core.ImageExtensions)
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Converter", Icon: "repeat", Category: core.CategoryMedia,
		Tagline:      "Convert audio, video and images with presets",
		Description:  "Batch-convert media between formats with sensible presets, powered by ffmpeg.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: Accepts()},
		Requires:     []string{"ffmpeg", "ffprobe"},
		OutputSubdir: "Converted", Order: 130, SplitInputs: true, MaxInputs: 100,
	}
}
