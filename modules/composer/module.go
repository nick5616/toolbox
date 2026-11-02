// Package composer is the Photo Composer (SPEC.md Part B §B5): layered
// compositions rendered in the webview (frontend/src/composer/render.ts) and
// stored here as projects with their latest render.
//
// CONTRACT STUB (Wave B0): document.go, the descriptor, Config, Register,
// the exported methods and service.go signatures are final; WP-CO1
// implements them.
package composer

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/projectdocs"
	"toolbox/core/sidecar"
)

// ModuleID is the Photo Composer's module ID.
const ModuleID = "photo-composer"

// Limits (SPEC.md §B5.1, §B5.4).
const (
	MaxLayers      = 60
	MaxTextChars   = 500
	MaxRenderBytes = 40 << 20
	MaxLoadDim     = 4096
)

// Config wires the module.
type Config struct {
	Store       core.ProjectStore
	ProjectsDir string // <support>/projects
	CacheDir    string // <support>/cache/composer (scaled and HEIC-converted images)
	Engine      sidecar.Caller
	Jobs        *core.Jobs
	Outputs     core.OutputStore
	Emitter     core.Emitter
	LibraryDir  func() string
}

// Module is the Photo Composer. It runs no jobs (JobLess); background
// removal is a Background Remover job.
type Module struct {
	cfg  Config
	docs *projectdocs.Docs
}

// New builds the module.
func New(cfg Config) *Module {
	m := &Module{cfg: cfg}
	m.docs = &projectdocs.Docs{Store: cfg.Store, Root: cfg.ProjectsDir, Kind: core.ProjectComposition, Summarize: summarize}
	return m
}

// Register adds the module to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Photo Composer", Icon: "layers", Category: core.CategoryImage,
		Tagline:      "Layer photos, cut-outs and text into one image",
		Description:  "Place cut-out photos and text on a background, with outlines, shadows and one-click layouts.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: slices.Clone(media.ImageExtensions())},
		Recommends:   []string{sidecar.DepID},
		OutputSubdir: "Compositions", Order: 145, JobLess: true, NotAStep: true,
	}
}

// Validate implements core.Module.
func (m *Module) Validate([]string, json.RawMessage) error { return core.ErrJobLess }

// Run implements core.Module.
func (m *Module) Run(context.Context, *core.JobContext) error { return core.ErrJobLess }

// Docs gives other modules (Post Builder) read access to compositions.
func (m *Module) Docs() *projectdocs.Docs { return m.docs }

// Get returns a composition document.
func (m *Module) Get(ctx context.Context, id string) (Composition, error) {
	return projectdocs.Get[Composition](ctx, m.docs, id)
}

// RenderPath returns the latest stored render of a composition, or a
// CodeNotFound error when it was never rendered.
func (m *Module) RenderPath(id string) (string, error) {
	return "", core.NotImplemented("Photo Composer renders") // WP-CO1
}

// summarize counts layers and missing sources.
func summarize(data string) (items, missing int) {
	var c Composition
	if json.Unmarshal([]byte(data), &c) != nil {
		return 0, 0
	}
	var paths []string
	if c.Background.Image != nil {
		paths = append(paths, c.Background.Image.Path)
	}
	for _, l := range c.Layers {
		if l.Image != nil {
			paths = append(paths, l.Image.Ref.Path)
		}
	}
	return len(c.Layers), projectdocs.MissingPaths(paths...)
}
