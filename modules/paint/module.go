// Package paint is Paint+ (Phase 19, SPEC.md §1–§2): a layered painting app
// whose pixels live in 512 px tiles under <support>/projects/<id>/layers/,
// rendered and painted in the webview (frontend/src/paint/). Go stores
// projects and tiles, flattens exports, imports brushes, and runs the Lab's
// perception tools on the AI engine through the hidden "paint-ai" module.
//
// CONTRACT SKELETON (Wave 0): exported names and signatures are frozen.
// P3 implements projects/export/pipeline, P4 ai.go, B1 brushes.go and
// brushimport/.
package paint

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/projectdocs"
	"toolbox/core/sidecar"
)

// ModuleID is Paint+'s module ID.
const ModuleID = "paint"

// Limits (SPEC.md §1.1, §2.2, §4).
const (
	MaxSide        = 8192
	MaxPixels      = 40_000_000
	MaxLayers      = 64
	TileSize       = 512
	MaxTileBytes   = 2 << 20  // one tile's PNG data URL
	MaxTilesPerGet = 64       // Tiles() keys per call
	MaxRenderBytes = 40 << 20 // SaveThumb's render PNG
	MaxPalette     = 64
	MaxAICropBytes = 24 << 20 // AIRequest.Source / Mask data URLs
)

// Config wires the module.
type Config struct {
	Store       core.ProjectStore
	ProjectsDir string // <support>/projects
	SupportDir  string // <support> (brushes live in <support>/paint/brushes)
	TmpDir      string // <support>/tmp (AI crops in <support>/tmp/paint/<jobID>)
	Engine      sidecar.Caller
	Jobs        *core.Jobs
	Outputs     core.OutputStore
	Emitter     core.Emitter
	LibraryDir  func() string
	Resolve     func(depID string) (string, error) // FFmpeg for WebP export
	// Models resolves the perception models through the modules that own
	// them (eraser, bgremove, editstudio matte, upscale); set in main.go.
	Models ModelResolver
	// Dialogs are the file dialogs for brush import and export (modules can't
	// import Wails); set in main.go. Nil functions make those calls fail cleanly.
	Dialogs BrushDialogs
}

// ModelResolver finds (never downloads) a perception model's files. Each
// method returns the engine params for the model ("model" object or path)
// and whether it is installed.
type ModelResolver interface {
	// Inpaint: "best" (LaMa) | "fast" (MI-GAN).
	Inpaint(model string) (json.RawMessage, bool)
	// Cutout: "fast" | "balanced" | "best" (bg-removal presets).
	Cutout(model string) (json.RawMessage, bool)
	// Segment: SAM 2.1 tiny.
	Segment() (json.RawMessage, bool)
	// Enhance: a CPU upscaler preset ID ("" = the default).
	Enhance(preset string) (json.RawMessage, bool)
}

// Module is Paint+.
type Module struct {
	cfg  Config
	docs *projectdocs.Docs
}

// New builds the module.
func New(cfg Config) *Module {
	m := &Module{cfg: cfg}
	m.docs = &projectdocs.Docs{Store: cfg.Store, Root: cfg.ProjectsDir, Kind: core.ProjectPaint, Summarize: summarize}
	return m
}

// Register adds Paint+ and its hidden AI module to the registry.
func Register(reg *core.Registry, m *Module) error {
	if err := reg.Register(m); err != nil {
		return err
	}
	return reg.Register(&AIModule{m: m})
}

// Accepts lists what Paint+ opens: photos and OpenRaster files.
func Accepts() []string { return append(slices.Clone(media.ImageExtensions()), ".ora") }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Paint+", Icon: "brush", Category: core.CategoryImage,
		Tagline:      "Paint and draw with layers, real brushes and the Lab",
		Description:  "A painting app with layers, pen pressure and a deep brush library, plus the Lab: algorithmic brushes and perception tools like Dissolve.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: Accepts()},
		Recommends:   []string{sidecar.DepID},
		OutputSubdir: "Paintings", Order: 11, MaxConcurrent: 2,
	}
}

// Validate implements core.Module (export and step jobs).
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module: an export job (PaintService.Export) or a
// pipeline step job (overlay / dissolve).
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }

// Docs gives other code read access to Paint+ projects.
func (m *Module) Docs() *projectdocs.Docs { return m.docs }

// summarize counts layers.
func summarize(data string) (items, missing int) {
	var d PaintDoc
	if json.Unmarshal([]byte(data), &d) != nil {
		return 0, 0
	}
	return len(d.Layers), 0
}
