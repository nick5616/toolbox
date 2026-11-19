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
	Caller    sidecar.Caller       // depth.* handlers
	Broker    *viz.RenderBroker    // stills and edits render in the main window
	Text      core.TextGenerator   // Vibe (nil = unavailable)
	Vision    core.VisionGenerator // Read the picture (nil = unavailable)
	ModelsDir string               // <models>; depth lives in <models>/depth
	CacheDir  string               // <cache>/grade
	LooksFile string               // <support>/grade/looks.json
	Analyzer  *viz.Analyzer        // beat sync
	Edit      EditRenderer         // modules/editstudio (videos, people/subject mattes)
}

// EditRenderer is the part of modules/editstudio the grade job uses
// (exported there in modules/editstudio/exports.go by G2).
type EditRenderer interface {
	// RenderEdit exports an in-memory edit (projectID "") into outPath's
	// folder with the plan's Grade applied by the host.
	RenderEdit(ctx context.Context, job *core.JobContext, name string, docJSON json.RawMessage, grade *viz.GradePlan, outPath string) error
}

// Module implements core.Module, core.Chainable and core.ModelProvider.
type Module struct{ cfg Config }

// New makes the module.
func New(cfg Config) *Module { return &Module{cfg: cfg} }

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

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, raw json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	var o Options
	if err := json.Unmarshal(raw, &o); err != nil {
		return core.ValidationError("Invalid options", nil)
	}
	return nil
}

// Run implements core.Module. G2 implements it (SPEC §E4).
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeInternal, "Color Grader isn't ready yet")
}
