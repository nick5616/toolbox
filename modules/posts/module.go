// Package posts is the Post Builder (SPEC.md Part B §B7): Instagram-ready
// posts (carousel, reel, story) made of photos, clips, compositions and
// video projects, exported as a numbered folder.
//
// CONTRACT STUB (Wave B0): document.go, the descriptor, Config, Register,
// Options and the service signatures are final; WP-PB1 implements them.
package posts

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"
	"unicode/utf8"

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

const (
	// ActionExport writes the post's folder.
	ActionExport Action = "export"
	// ActionMake (the pipeline step, Phase 14) turns the job's input files
	// into a new post, saves it as a project and exports it.
	ActionMake Action = "make"
)

// Options are the job options.
type Options struct {
	Action    Action `json:"action"`
	ProjectID string `json:"projectId"` // export

	// make: the new post. The inputs are its photos and clips, in order.
	Name         string `json:"name"`         // "" = the first file's name
	Format       string `json:"format"`       // "carousel" | "reel" | "story"
	Aspect       string `json:"aspect"`       // carousel; reels and stories are 9:16
	Caption      string `json:"caption"`      // ≤ 2,200 chars
	KeepLocation bool   `json:"keepLocation"` // keep location and metadata
}

// ExportResult is an export job's result.
type ExportResult struct {
	Folder    string   `json:"folder"`
	Files     []string `json:"files"`
	ProjectID string   `json:"projectId"` // the post that was exported
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
	LibraryDir  func() string // the Library folder (a source folder may not be inside it); nil = the default
}

// Module is the Post Builder.
type Module struct {
	cfg    Config
	docs   *projectdocs.Docs
	comps  compositions // nil when the Photo Composer isn't wired
	videos videos       // nil when the Video Editor isn't wired
	now    func() time.Time
}

// New builds the module.
func New(cfg Config) *Module {
	m := &Module{cfg: cfg, now: time.Now}
	if cfg.Composer != nil {
		m.comps = cfg.Composer
	}
	if cfg.Video != nil {
		m.videos = cfg.Video
	}
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
		OutputSubdir: "Posts", Order: 11, MaxConcurrent: 1,
		Parts: []string{"photo-composer", "video-editor", "bg-remover", "upscaler"},
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	switch o.Action {
	case ActionExport:
		if o.ProjectID == "" {
			return core.ValidationError("Choose a post to export", map[string]string{"projectId": "required"})
		}
	case ActionMake:
		return validateMake(o, inputs)
	default:
		return core.ValidationError("Unknown Post Builder action", map[string]string{"action": "must be export or make"})
	}
	return nil
}

// validateMake checks a make job: its files and the shape of the new post.
func validateMake(o Options, inputs []string) error {
	if len(inputs) == 0 {
		return core.ValidationError("Add photos or clips for the post", map[string]string{"inputs": "Add at least one file"})
	}
	if len(inputs) > DefaultLimits().MaxSlides {
		return core.ValidationError(fmt.Sprintf("A post has at most %d slides", DefaultLimits().MaxSlides), nil)
	}
	if _, err := normalizeFormat(o.Format, o.Aspect); err != nil {
		return err
	}
	if utf8.RuneCountInString(o.Caption) > DefaultLimits().MaxCaptionChars {
		return core.ValidationError("The caption is too long", map[string]string{"caption": "At most 2,200 characters"})
	}
	if o.Format == "reel" && len(inputs) != 1 {
		return core.ValidationError("A reel is exactly one video", map[string]string{"inputs": "Use one video"})
	}
	return nil
}

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
