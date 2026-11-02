// Package videoeditor is the Video Editor (SPEC.md Part B §B6): video
// projects (clips, photos, transitions, music, titles) rendered with FFmpeg.
//
// CONTRACT STUB (Wave B0): document.go, the descriptor, Config, Register,
// Options, RenderProject and the service signatures are final; WP-VE1
// implements them.
package videoeditor

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/projectdocs"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// ModuleID is the Video Editor's module ID.
const ModuleID = "video-editor"

// Limits (SPEC.md §B6.1).
const (
	MaxClips    = 200
	MaxTitles   = 100
	MaxTotalMs  = 30 * 60 * 1000
	FPS         = 30
	MinClipMs   = 300
	MinPhotoMs  = 1000
	MaxPhotoMs  = 10000
	MaxTitleLen = 200
)

// Action is what one Video Editor job does.
type Action string

const (
	ActionRender  Action = "render"  // the project into <library>/Edits
	ActionPreview Action = "preview" // 540p into <support>/projects/<id>/preview.mp4
	ActionPlan    Action = "plan"    // Quick vlog: builds a new project (result {projectId})
)

// Options are the job options.
type Options struct {
	Action    Action       `json:"action"`
	ProjectID string       `json:"projectId"` // render/preview
	Plan      *PlanRequest `json:"plan"`      // plan
}

// PlanResult is a plan job's result.
type PlanResult struct {
	ProjectID string `json:"projectId"`
}

// RenderOptions tune RenderProject.
type RenderOptions struct {
	Width      int // output frame; 0 = the project's aspect at 1080
	Height     int
	MaxSeconds int64 // 0 = no cap; else the timeline is cut there
	Preview    bool  // 540p, veryfast, CRF 28
}

// ClipInfo describes a source file (Probe).
type ClipInfo struct {
	Path       string  `json:"path"`
	Kind       string  `json:"kind"` // "video" | "image" | "audio" | ""
	DurationMs int64   `json:"durationMs"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	FPS        float64 `json:"fps"`
	Rotation   int     `json:"rotation"`
	HasAudio   bool    `json:"hasAudio"`
	TakenAt    int64   `json:"takenAt"` // Unix ms; 0 = unknown
	Error      string  `json:"error"`
}

// Config wires the module.
type Config struct {
	Store       core.ProjectStore
	ProjectsDir string         // <support>/projects
	Engine      sidecar.Caller // HEIC photos
	Analyzer    *viz.Analyzer  // beats for Quick vlog
	Resolve     func(depID string) (string, error)
	Jobs        *core.Jobs
}

// Module is the Video Editor.
type Module struct {
	cfg  Config
	docs *projectdocs.Docs
}

// New builds the module.
func New(cfg Config) *Module {
	m := &Module{cfg: cfg}
	m.docs = &projectdocs.Docs{Store: cfg.Store, Root: cfg.ProjectsDir, Kind: core.ProjectVideo, Summarize: summarize}
	return m
}

// Register adds the module to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Video Editor", Icon: "clapperboard", Category: core.CategoryMedia,
		Tagline:      "Stitch clips and photos into one video, with music and titles",
		Description:  "Order, trim and frame clips and photos, add transitions, music and titles, or build a quick vlog that cuts on the beat.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: slices.Concat(media.VideoExtensions(), media.ImageExtensions(), media.AudioExtensions())},
		Requires:     []string{"ffmpeg", "ffprobe"},
		Recommends:   []string{sidecar.DepID},
		OutputSubdir: "Edits", Order: 125, MaxConcurrent: 1, NotAStep: true,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if _, err := core.DecodeOptionsJSON[Options](options); err != nil {
		return err
	}
	return core.NotImplemented("Video Editor") // WP-VE1
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("Video Editor") // WP-VE1
}

// Docs gives other modules (Post Builder) read access to video projects.
func (m *Module) Docs() *projectdocs.Docs { return m.docs }

// Get returns a video project document.
func (m *Module) Get(ctx context.Context, id string) (VideoProject, error) {
	return projectdocs.Get[VideoProject](ctx, m.docs, id)
}

// DurationMs is a project's timeline length.
func DurationMs(doc VideoProject) int64 { return 0 } // WP-VE1

// RenderProject renders doc into outPath inside an existing job (the Video
// Editor's own render job, or Post Builder's export). Progress is reported
// to job over the whole call.
func (m *Module) RenderProject(ctx context.Context, job *core.JobContext, doc VideoProject, outPath string, o RenderOptions) error {
	return core.NotImplemented("Video Editor renders") // WP-VE1
}

// summarize counts clips and missing sources.
func summarize(data string) (items, missing int) {
	var p VideoProject
	if json.Unmarshal([]byte(data), &p) != nil {
		return 0, 0
	}
	paths := make([]string, 0, len(p.Clips)+1)
	for _, c := range p.Clips {
		paths = append(paths, c.Path)
	}
	if p.Music != nil {
		paths = append(paths, p.Music.Path)
	}
	return len(p.Clips), projectdocs.MissingPaths(paths...)
}
