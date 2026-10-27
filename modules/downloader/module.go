// Package downloader is the yt-dlp based Downloader module. See SPEC.md §7.
//
// CONTRACT STUB (foundation): options.go and service.go are final; WP-D
// implements module.go's bodies plus validate.go, args.go, progress.go and
// run.go. Exported signatures are frozen.
package downloader

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// ModuleID is the downloader's module ID.
const ModuleID = "downloader"

// Module implements core.Module.
type Module struct {
	cacheDir string
}

// Register adds the downloader to the registry. cacheDir is passed to
// yt-dlp's --cache-dir.
func Register(reg *core.Registry, cacheDir string) error {
	return reg.Register(&Module{cacheDir: cacheDir})
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID:           ModuleID,
		Name:         "Downloader",
		Tagline:      "Grab audio or video from a link",
		Description:  "Download audio or video from YouTube and over a thousand other sites, with optional trimming and embedded metadata.",
		Icon:         "download",
		Category:     core.CategoryMedia,
		Status:       core.StatusReady,
		Accepts:      core.Accepts{URLs: true},
		Requires:     []string{"yt-dlp", "ffmpeg", "ffprobe"},
		Recommends:   []string{"deno"},
		OutputSubdir: "Downloads",
		Order:        10,
		SplitInputs:  true,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return core.NotImplemented("downloader.Validate")
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("downloader.Run")
}
