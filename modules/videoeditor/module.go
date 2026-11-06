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
	"os"
	"path/filepath"
	"slices"
	"strings"

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
	// bars gets a song's bar starts and length (a seam for tests).
	bars func(ctx context.Context, job *core.JobContext, song string) ([]int64, int64, error)
}

// New builds the module.
func New(cfg Config) *Module {
	m := &Module{cfg: cfg}
	m.bars = m.analyzeBars
	m.docs = &projectdocs.Docs{Store: cfg.Store, Root: cfg.ProjectsDir, Kind: core.ProjectVideo, Summarize: summarize}
	return m
}

// Register adds the module to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Sequence Editor", Icon: "film", Category: core.CategoryMedia,
		Tagline:      "Stitch clips and photos into one video, with music and titles",
		Description:  "Order, trim and frame clips and photos, add transitions, music and titles, or build a quick vlog that cuts on the beat.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: slices.Concat(media.VideoExtensions(), media.ImageExtensions(), media.AudioExtensions())},
		Requires:     []string{"ffmpeg", "ffprobe"},
		Recommends:   []string{sidecar.DepID},
		OutputSubdir: "Edits", Order: 16, MaxConcurrent: 1, NotAStep: true,
		// Phase 10: a part of Post Builder (its video slides) and reachable from
		// the Video Editor's home; the sidebar's Video Editor is the multitrack one.
		Hidden: true,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	switch o.Action {
	case ActionRender, ActionPreview:
		doc, err := m.Get(context.Background(), o.ProjectID)
		if err != nil {
			return err
		}
		return validateDoc(normalize(doc))
	case ActionPlan:
		if o.Plan == nil {
			return core.ValidationError("Pick the clips for the vlog", nil)
		}
		return validatePlan(*o.Plan)
	}
	return core.ValidationError("Unknown action", map[string]string{"action": "Render, preview or plan"})
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	switch o.Action {
	case ActionPlan:
		if o.Plan == nil {
			return core.ValidationError("Pick the clips for the vlog", nil)
		}
		return m.runPlan(ctx, job, *o.Plan)
	case ActionRender, ActionPreview:
		return m.runRender(ctx, job, o)
	}
	return core.ValidationError("Unknown action", map[string]string{"action": "Render, preview or plan"})
}

// runRender is the render and preview actions.
func (m *Module) runRender(ctx context.Context, job *core.JobContext, o Options) error {
	p, err := m.docs.Load(ctx, o.ProjectID)
	if err != nil {
		return err
	}
	doc, err := projectdocs.Get[VideoProject](ctx, m.docs, o.ProjectID)
	if err != nil {
		return err
	}
	job.SetTitle(p.Name)
	if o.Action == ActionPreview {
		dir := m.docs.Dir(o.ProjectID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't create the project folder").WithCause(err)
		}
		tmp := filepath.Join(dir, "preview.tmp.mp4")
		if err := m.RenderProject(ctx, job, doc, tmp, RenderOptions{Preview: true}); err != nil {
			_ = os.Remove(tmp)
			return err
		}
		if err := os.Rename(tmp, filepath.Join(dir, "preview.mp4")); err != nil {
			_ = os.Remove(tmp)
			return core.Errorf(core.CodeInternal, "Couldn't save the preview").WithCause(err)
		}
		return nil
	}
	out := core.UniquePath(job.OutputDir, fileStem(p.Name), ".mp4")
	if err := m.RenderProject(ctx, job, doc, out, RenderOptions{}); err != nil {
		return err
	}
	_, err = job.Output(out)
	return err
}

// Docs gives other modules (Post Builder) read access to video projects.
func (m *Module) Docs() *projectdocs.Docs { return m.docs }

// Get returns a video project document.
func (m *Module) Get(ctx context.Context, id string) (VideoProject, error) {
	return projectdocs.Get[VideoProject](ctx, m.docs, id)
}

// fileStem makes a project name safe as a file name on Windows and macOS.
func fileStem(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, projectdocs.CleanName(name))
	name = strings.Trim(name, " .")
	if name == "" {
		return "Video"
	}
	return name
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
