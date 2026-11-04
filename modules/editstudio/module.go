// Package editstudio is Edit Studio (SPEC.md Phase 9): song-driven music
// edits on the Visualizer's GPU engine. Go owns the projects, the edit
// sources (Annex-B streams FFmpeg makes for the webview's decoder), mattes,
// the export job and the text exports; the frontend draws every frame.
//
// CONTRACT (Wave 0): document.go, options.go, the descriptor, Config, the
// service signatures and the stub signatures in the other files are final.
// Work packages fill in the stubs' bodies (SPEC.md §18).
package editstudio

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/projectdocs"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// ModuleID is Edit Studio's module ID.
const ModuleID = "edit-studio"

// Limits (SPEC.md §15).
const (
	MaxTracks        = 8
	MaxClips         = 500
	MaxSources       = 300
	MaxCustomMarkers = 2000
	MaxOverrides     = 5000
	MinEditMs        = 1000
	MaxEditMs        = 10 * 60 * 1000
	MaxEffects       = 8
	MaxMasks         = 4
	MaxFieldBytes    = 64 << 10
	MaxLinesBytes    = 256 << 10
	MaxSelectMs      = 60_000
	MaxInterpMs      = 30_000
	MaxTextRows      = 20_000
	MaxThumbBytes    = 512 << 10
	MaxClicks        = 64
)

// Config wires the module.
type Config struct {
	Store       core.ProjectStore
	ProjectsDir string // <support>/projects
	CacheDir    string // <support>/cache/editstudio
	ModelsDir   string // <models>
	Engine      sidecar.Caller
	Analyzer    *viz.Analyzer
	Broker      *viz.RenderBroker
	Resolve     func(depID string) (string, error)
	Jobs        *core.Jobs
}

// Module is Edit Studio.
type Module struct {
	cfg  Config
	docs *projectdocs.Docs

	matteSem chan struct{} // one matte job at a time (§10.5)
	locks    sync.Map      // file key → *sync.Mutex (one transcode per stream, §7.1)

	// analyze is a seam for tests.
	analyze func(ctx context.Context, job *core.JobContext, input string, o viz.AnalyzeOptions) (viz.AnalysisRef, error)
}

// New builds the module.
func New(cfg Config) *Module {
	m := &Module{cfg: cfg, matteSem: make(chan struct{}, 1)}
	m.docs = &projectdocs.Docs{Store: cfg.Store, Root: cfg.ProjectsDir, Kind: core.ProjectEdit, Summarize: summarize, Flags: projectFlags}
	m.analyze = func(ctx context.Context, job *core.JobContext, input string, o viz.AnalyzeOptions) (viz.AnalysisRef, error) {
		if cfg.Analyzer == nil {
			return viz.AnalysisRef{}, core.Errorf(core.CodeInternal, "Song analysis isn't available")
		}
		return cfg.Analyzer.Analyze(ctx, job, input, o)
	}
	return m
}

// Register adds the module to the registry.
func Register(reg *core.Registry, m *Module) error {
	if err := reg.Register(m); err != nil {
		return err
	}
	return reg.Register(NewVideoModule(m))
}

// Docs gives other code read access to edit projects.
func (m *Module) Docs() *projectdocs.Docs { return m.docs }

// Get returns an edit project document.
func (m *Module) Get(ctx context.Context, id string) (EditProject, error) {
	return projectdocs.Get[EditProject](ctx, m.docs, id)
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Edit Studio", Icon: "audio-waveform", Category: core.CategoryMedia,
		Tagline:      "Cut clips and photos to a song's beats, drops and words",
		Description:  "Pick a song to get its beats, kicks, drops and words as snap markers, drop in clips and photos, auto-fill a draft, then add cut-outs, captions and hit effects.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: slices.Concat(media.AudioExtensions(), media.VideoExtensions(), media.ImageExtensions())},
		Requires:     []string{"ffmpeg", "ffprobe", sidecar.DepID},
		OutputSubdir: "Edits", Order: 14, MaxConcurrent: 2, NotAStep: true,
		Base:  VideoModuleID,
		Parts: []string{"visualizer", "stems", "transcribe", "bg-remover"},
	}
}

// Validate implements core.Module: the request's shape; files are checked in Run.
func (m *Module) Validate(_ []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return m.validateOptions(o)
}

func (m *Module) validateOptions(o Options) error {
	needProject := func() error {
		if o.ProjectID == "" {
			return vErr("projectId", "Open an edit first")
		}
		if _, err := m.docs.Load(context.Background(), o.ProjectID); err != nil {
			return err
		}
		return nil
	}
	switch o.Action {
	case ActionAnalyze:
		if o.Analyze == nil {
			return vErr("analyze", "Pick a song to analyze")
		}
		return validateAnalyze(*o.Analyze)
	case ActionPrepare:
		if o.Prepare == nil {
			return vErr("prepare", "Add some clips or photos")
		}
		return validatePrepare(*o.Prepare)
	case ActionInterp:
		if o.Interp == nil {
			return vErr("interp", "Pick a clip")
		}
		return validateInterp(*o.Interp)
	case ActionMatte:
		if o.Matte == nil {
			return vErr("matte", "Pick a clip")
		}
		if err := needProject(); err != nil {
			return err
		}
		return validateMatte(*o.Matte)
	case ActionRender:
		return needProject()
	case ActionText:
		if o.Text == nil {
			return vErr("text", "Nothing to save")
		}
		return validateText(*o.Text)
	}
	return core.ValidationError("Unknown action", map[string]string{"action": "Unknown action"})
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := m.validateOptions(o); err != nil {
		return err
	}
	switch o.Action {
	case ActionAnalyze:
		return m.runAnalyze(ctx, job, *o.Analyze)
	case ActionPrepare:
		return m.runPrepare(ctx, job, *o.Prepare)
	case ActionInterp:
		return m.runInterp(ctx, job, *o.Interp)
	case ActionMatte:
		return m.runMatte(ctx, job, o.ProjectID, *o.Matte)
	case ActionRender:
		return m.runRender(ctx, job, o.ProjectID)
	case ActionText:
		return m.runText(ctx, job, *o.Text)
	}
	return core.ValidationError("Unknown action", nil)
}

// runAnalyze analyses a song with stems on and mood off (§11.5).
func (m *Module) runAnalyze(ctx context.Context, job *core.JobContext, req AnalyzeRequest) error {
	job.SetTitle("Analyzing — " + filepath.Base(req.Song))
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	words := req.Words
	if words == "" {
		words = viz.WordsNone
	}
	ref, err := m.analyze(ctx, job, req.Song, viz.AnalyzeOptions{
		Stems: true, Words: words, LyricsText: req.LyricsText, Language: req.Language, Mood: false,
	})
	if err != nil {
		return err
	}
	return job.SetResult(Result{Action: ActionAnalyze, Analysis: &ref})
}

// acquireMatte takes the module's matte slot, waiting while another matte runs.
func (m *Module) acquireMatte(ctx context.Context, job *core.JobContext) (release func(), err error) {
	select {
	case m.matteSem <- struct{}{}:
	default:
		job.Progress(core.IndeterminateProgress, "Waiting for another cut-out")
		select {
		case m.matteSem <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return func() { <-m.matteSem }, nil
}

// fileStem makes a name safe as a file name on Windows and macOS.
func fileStem(name, fallback string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, projectdocs.CleanName(name))
	name = strings.Trim(name, " .")
	if name == "" {
		return fallback
	}
	return name
}

// summarize counts clips and missing files (song, clips, sources).
func summarize(data string) (items, missing int) {
	var p EditProject
	if json.Unmarshal([]byte(data), &p) != nil {
		return 0, 0
	}
	seen := map[string]bool{}
	var paths []string
	add := func(p string) {
		if p != "" && !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}
	if p.Song != nil {
		add(p.Song.Path)
	}
	for _, t := range p.Tracks {
		for _, c := range t.Clips {
			items++
			add(c.Path)
		}
	}
	for _, s := range p.Sources {
		add(s.Path)
	}
	return items, projectdocs.MissingPaths(paths...)
}
