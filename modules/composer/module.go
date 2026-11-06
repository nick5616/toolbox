// Package composer is the Photo Composer (SPEC.md Part B §B5): layered
// compositions rendered in the webview (frontend/src/composer/render.ts) and
// stored here as projects with their latest render.
package composer

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
	Broker      *viz.RenderBroker // "Fill a template" renders in the main window through it
}

// Module is the Photo Composer. Interactively it runs no jobs (background
// removal is a Background Remover job); its one job is "Fill a template", a
// pipeline step (fill.go, pipeline.go).
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
		OutputSubdir: "Compositions", Order: 12, MaxConcurrent: 1,
		Parts: []string{"bg-remover", "object-eraser", "upscaler"},
	}
}

// Docs gives other modules (Post Builder) read access to compositions.
func (m *Module) Docs() *projectdocs.Docs { return m.docs }

// Get returns a composition document.
func (m *Module) Get(ctx context.Context, id string) (Composition, error) {
	return projectdocs.Get[Composition](ctx, m.docs, id)
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
