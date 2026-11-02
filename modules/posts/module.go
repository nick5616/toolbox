// Package posts is the Post Builder (SPEC.md Part B §B7): Instagram-ready
// posts (carousel, reel, story) made of photos, clips, compositions and
// video projects, exported as a numbered folder.
//
// CONTRACT STUB (Wave B0): document.go, the descriptor, Config, Register,
// Options and the service signatures are final; WP-PB1 implements them.
package posts

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/projectdocs"
	"toolbox/core/sidecar"
	"toolbox/modules/composer"
	"toolbox/modules/videoeditor"
)

// ModuleID is the Post Builder's module ID.
const ModuleID = "post-builder"

// Action is what one Post Builder job does.
type Action string

// ActionExport writes the post's folder.
const ActionExport Action = "export"

// Options are the job options.
type Options struct {
	Action    Action `json:"action"`
	ProjectID string `json:"projectId"`
}

// ExportResult is an export job's result.
type ExportResult struct {
	Folder string   `json:"folder"`
	Files  []string `json:"files"`
}

// SlideSource describes a file before it becomes a slide.
type SlideSource struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"` // "photo" | "clip" | "" (not usable)
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	DurationMs int64  `json:"durationMs"`
	HasGPS     bool   `json:"hasGps"`
	HEIC       bool   `json:"heic"`
	Error      string `json:"error"`
}

// Config wires the module.
type Config struct {
	Store       core.ProjectStore
	ProjectsDir string         // <support>/projects
	Engine      sidecar.Caller // HEIC photos
	Composer    *composer.Module
	Video       *videoeditor.Module
	Resolve     func(depID string) (string, error)
}

// Module is the Post Builder.
type Module struct {
	cfg  Config
	docs *projectdocs.Docs
}

// New builds the module.
func New(cfg Config) *Module {
	m := &Module{cfg: cfg}
	m.docs = &projectdocs.Docs{Store: cfg.Store, Root: cfg.ProjectsDir, Kind: core.ProjectPost, Summarize: summarize}
	return m
}

// Register adds the module to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Post Builder", Icon: "gallery-horizontal-end", Category: core.CategoryMedia,
		Tagline:      "Build Instagram posts from photos, clips, collages and edits",
		Description:  "Arrange up to 20 slides, frame and trim them, write the caption, and export a folder ready to upload.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: slices.Concat(media.ImageExtensions(), media.VideoExtensions())},
		Requires:     []string{"ffmpeg", "ffprobe"},
		Recommends:   []string{sidecar.DepID},
		OutputSubdir: "Posts", Order: 120, MaxConcurrent: 1, NotAStep: true,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if _, err := core.DecodeOptionsJSON[Options](options); err != nil {
		return err
	}
	return core.NotImplemented("Post Builder") // WP-PB1
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("Post Builder") // WP-PB1
}

// Check validates a post against Instagram's limits (SPEC.md §B7.2).
func (m *Module) Check(ctx context.Context, doc Post) []Issue { return []Issue{} } // WP-PB1

// summarize counts slides and missing sources.
func summarize(data string) (items, missing int) {
	var p Post
	if json.Unmarshal([]byte(data), &p) != nil {
		return 0, 0
	}
	paths := make([]string, 0, len(p.Slides))
	for _, s := range p.Slides {
		paths = append(paths, s.Path)
	}
	return len(p.Slides), projectdocs.MissingPaths(paths...)
}
