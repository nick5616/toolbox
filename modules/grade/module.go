// Package grade is Color Grader (Phase 21 SPEC Part E): colour grading for
// pictures and videos, from film looks to absolutely unhinged. Looks are
// recipes (recipe.go) compiled by the frontend (frontend/src/grade
// compileRecipe) into editor effects and rendered by the editor's engine
// through core/viz's RenderBroker: pictures as a Still plan at full
// resolution, videos as an in-memory edit (modules/editstudio RenderEdit).
// Region maps (subject, people, depth) are made by the AI engine and cached
// in <cache>/grade/.
package grade

import (
	"context"
	"encoding/json"
	"slices"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// ModuleID is the module's ID.
const ModuleID = "grade"

// Accepts lists pictures and videos.
func Accepts() []string {
	exts := append(slices.Clone(media.ImageExtensions()), ".gif")
	return append(exts, media.VideoExtensions()...)
}

// Config wires the module (main.go).
type Config struct {
	Caller    sidecar.Caller       // depth.* handlers and bgremove.run
	Broker    *viz.RenderBroker    // stills and edits render in the main window
	Text      core.TextGenerator   // Vibe (nil = unavailable)
	Vision    core.VisionGenerator // Read the picture (nil = unavailable)
	ModelsDir string               // <models>; depth lives in <models>/depth
	CacheDir  string               // <cache>/grade
	LooksFile string               // <support>/grade/looks.json
	Analyzer  *viz.Analyzer        // beat sync
	Edit      EditRenderer         // modules/editstudio (videos, people/subject mattes)

	// Added by G2.
	Resolve    func(depID string) (string, error) // ffmpeg for Read's video frame (nil = unavailable)
	LibraryDir func() string                      // <library>: .cube files go to <library>/Graded/LUTs
	Outputs    core.OutputStore                   // registers .cube files in the Library (nil = not registered)
	Jobs       *core.Jobs                         // Maps' "preparing" state (nil = none)
}

// EditRenderer is the part of modules/editstudio the grade job uses
// (exported there in modules/editstudio/exports.go by G2). It speaks only
// primitives and core/viz types so neither package imports the other.
type EditRenderer interface {
	// RenderEdit exports an in-memory edit (no stored project) to outPath
	// with the plan's Grade applied by the host. extra carries the region
	// maps the clips' Matte and Depth refer to (EditFiles keys "m:<id>" and
	// "d:<id>"); they are added to the plan's streams and images.
	RenderEdit(ctx context.Context, job *core.JobContext, name string, docJSON json.RawMessage, grade *viz.GradePlan, outPath string, extra *viz.EditPlan) error
	// RunMatte makes a video's people matte (source range fromMs..toMs at fps,
	// export tier's short side capped at exportShort) as dir/<name>-export.h264
	// and dir/<name>-preview.h264 (+ .idx.json).
	RunMatte(ctx context.Context, job *core.JobContext, path, dir, name string, fromMs, toMs int64, fps, exportShort int) (export, preview viz.EditPlanStream, err error)
	// RunImageMatte makes a picture's subject alpha (Background Remover
	// model) as the PNG dst.
	RunImageMatte(ctx context.Context, job *core.JobContext, path, dst string) error
	// PrepareStream makes (or reuses) a video's edit stream at a short side
	// and fps (the frames the editor plays) and returns its files and size.
	PrepareStream(ctx context.Context, job *core.JobContext, path string, short, fps int, onProgress func(float64)) (stream, index string, width, height, frames int, err error)
	// WriteStreamIndex writes the .idx.json next to an Annex-B stream a
	// handler made.
	WriteStreamIndex(stream string, width, height, fps int) error
	// MatteModelsPresent says whether the people-matte (videos) and the
	// photo cut-out (pictures) models are installed.
	MatteModelsPresent() (people, image bool)
}

// Module implements core.Module, core.Chainable and core.ModelProvider.
type Module struct {
	cfg Config

	vibeMu     sync.Mutex
	vibeCancel context.CancelFunc
	mapsSem    chan struct{} // one map build at a time (they're heavy)
}

// New makes the module.
func New(cfg Config) *Module { return &Module{cfg: cfg, mapsSem: make(chan struct{}, 1)} }

// Register adds the module to reg.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Color Grader", Icon: "palette", Category: core.CategoryImage,
		Tagline:     "Film looks to absolutely unhinged",
		Description: "Grades pictures and videos with 40 looks from tasteful to bonkers, looks the local AI writes from a vibe or picks for your picture, and different grades for the subject, the background, near and far.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Recommends:  []string{sidecar.DepID},
		Order:       128, OutputSubdir: "Graded",
		SplitInputs: true, MaxInputs: 200,
		Parts: []string{},
	}
}

// IsInteractive implements core.InteractiveJobs: a map build is something the
// user waits for in the Regions panel; grading is a batch job.
func (m *Module) IsInteractive(raw json.RawMessage) bool {
	var o struct {
		Action string `json:"action"`
	}
	return json.Unmarshal(raw, &o) == nil && o.Action == ActionMaps
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, raw json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	o, err := decodeOptions(raw)
	if err != nil {
		return err
	}
	if o.Action == ActionMaps {
		if len(inputs) != 1 {
			return core.ValidationError("Prepare the maps of one file at a time", nil)
		}
		_, err := mapKinds(o.MapKinds)
		return err
	}
	return checkOptions(o)
}
