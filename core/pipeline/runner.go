// Package pipeline runs pipelines: chains of tools whose steps are ordinary
// jobs (SPEC.md §8). A run isn't a job; the Runner is one event loop that
// submits tagged jobs (core.Jobs.SubmitFor) and follows them through
// core.Jobs.Observe. It imports core only.
package pipeline

import (
	"context"
	"sync"
	"time"

	"toolbox/core"
)

// Limits (SPEC.md §8).
const (
	MaxPipelines     = 100
	MaxSteps         = 30
	MaxItems         = 200
	MaxJobsPerRun    = 2000
	MaxFilesPerCell  = 1000
	MaxRunStateBytes = 16 << 20
	MaxOptionsBytes  = 1 << 20
	KeepFinishedRuns = 200
	WaitRetry        = 5 * time.Second
	WatchInterval    = 5 * time.Second
	RunEventInterval = 250 * time.Millisecond
)

// Special From values and the Check step type.
const (
	FromInput = "input"
	FromNone  = "none"
	CheckType = "pipelines.check"
)

// Config wires a Runner.
type Config struct {
	Store    core.PipelineStore
	Outputs  core.OutputStore
	Jobs     *core.Jobs
	Reg      *core.Registry
	Em       core.Emitter
	Tools    func(depID string) (string, error) // dependency check at Start
	Settings func() core.Settings
	Clock    func() time.Time // tests; nil = time.Now
}

// builtin is a step type registered by modules/pipelines.
type builtin struct {
	t core.StepType
	a core.Chainable
}

// Runner owns pipelines, runs and watch folders.
type Runner struct {
	cfg Config

	mu        sync.Mutex
	builtins  []builtin
	needsYou  func(total int, firstRunName string)
	started   bool
	stopped   bool
	stopFuncs []func()
}

// New builds a Runner; nothing runs until Start.
func New(cfg Config) *Runner {
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.Em == nil {
		cfg.Em = core.NopEmitter{}
	}
	return &Runner{cfg: cfg}
}

// RegisterBuiltin adds a built-in step type (modules/pipelines). A nil
// adapter is allowed only for CheckType.
func (r *Runner) RegisterBuiltin(t core.StepType, a core.Chainable) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t.ID == "" {
		return core.Errorf(core.CodeInternal, "builtin step type without an ID")
	}
	for _, b := range r.builtins {
		if b.t.ID == t.ID {
			return core.Errorf(core.CodeConflict, "step type %q registered twice", t.ID)
		}
	}
	if a == nil && t.ID != CheckType {
		return core.Errorf(core.CodeInternal, "builtin step type %q without an adapter", t.ID)
	}
	t.Builtin = true
	r.builtins = append(r.builtins, builtin{t: t, a: a})
	return nil
}

// OnNeedsYou is called (from the loop) whenever the total of NeedsYou over
// active runs changes; main.go wires it to the tray.
func (r *Runner) OnNeedsYou(fn func(total int, firstRunName string)) {
	r.mu.Lock()
	r.needsYou = fn
	r.mu.Unlock()
}

// Start loads pipelines and active runs, reconciles them with their jobs,
// starts observing jobs and polling watch folders. Call after Jobs.Start.
func (r *Runner) Start(ctx context.Context) error {
	r.mu.Lock()
	r.started = true
	r.mu.Unlock()
	return nil // WP-PR1
}

// Stop stops the loop and the watchers and persists state. Idempotent.
func (r *Runner) Stop() {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.stopped = true
	fns := r.stopFuncs
	r.stopFuncs = nil
	r.mu.Unlock()
	for _, f := range fns {
		f()
	}
}

func notImplemented(what string) error { return core.NotImplemented("Pipelines: " + what) }

// --- Pipelines ---

// List returns every pipeline with its check, watch state and last run.
func (r *Runner) List() []core.PipelineEntry { return []core.PipelineEntry{} } // WP-PR1

// Get returns one pipeline.
func (r *Runner) Get(id string) (core.Pipeline, error) {
	return core.Pipeline{}, notImplemented("Get")
}

// Save validates the shape (not the steps' problems: those only block
// running), fills IDs and times, persists and emits pipelines:changed.
func (r *Runner) Save(p core.Pipeline) (core.PipelineEntry, error) {
	return core.PipelineEntry{}, notImplemented("Save")
}

// Delete removes a pipeline (its runs keep going and stay in history).
func (r *Runner) Delete(id string) error { return notImplemented("Delete") }

// Duplicate saves a copy named "<name> copy".
func (r *Runner) Duplicate(id string) (core.PipelineEntry, error) {
	return core.PipelineEntry{}, notImplemented("Duplicate")
}

// --- Runs ---

// StartRun preflights and starts a run (SPEC.md §8.3).
func (r *Runner) StartRun(req core.RunRequest, trigger string) (core.PipelineRun, error) {
	return core.PipelineRun{}, notImplemented("StartRun")
}

// Runs lists runs, newest first.
func (r *Runner) Runs(f core.RunFilter) ([]core.PipelineRun, error) {
	return []core.PipelineRun{}, nil // WP-PR1
}

// Run returns one run.
func (r *Runner) Run(id string) (core.PipelineRun, error) {
	return core.PipelineRun{}, notImplemented("Run")
}

// Cancel cancels a run (SPEC.md §8.7).
func (r *Runner) Cancel(runID string) error { return notImplemented("Cancel") }

// Retry retries a run's failed and cancelled cells.
func (r *Runner) Retry(runID string) (core.PipelineRun, error) {
	return core.PipelineRun{}, notImplemented("Retry")
}

// Continue carries a waiting manual or check cell on.
func (r *Runner) Continue(req core.ContinueRequest) error { return notImplemented("Continue") }

// SkipStep carries a waiting manual or check cell's inputs on unchanged.
func (r *Runner) SkipStep(runID string, item int, stepID string) error {
	return notImplemented("SkipStep")
}

// StopItem cancels one item's active jobs; its later cells are blocked.
func (r *Runner) StopItem(runID string, item int) error { return notImplemented("StopItem") }

// CleanUp deletes a finished run's temporary files now.
func (r *Runner) CleanUp(runID string) (int, error) { return 0, notImplemented("CleanUp") }

// Remove deletes a finished run (optionally its temporary files too).
func (r *Runner) Remove(runID string, deleteTemporary bool) error {
	return notImplemented("Remove")
}
