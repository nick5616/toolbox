// Package pipeline runs pipelines: chains of tools whose steps are ordinary
// jobs (SPEC.md §8). A run isn't a job; the Runner is one event loop that
// submits tagged jobs (core.Jobs.SubmitFor) and follows them through
// core.Jobs.Observe. It imports core only.
package pipeline

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
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
	Store   core.PipelineStore
	Outputs core.OutputStore
	Jobs    *core.Jobs
	Reg     *core.Registry
	Em      core.Emitter
	Tools   func(depID string) (string, error) // dependency check at Start
	// Known reads a dependency's cached status without running anything
	// (deps.Service.Known). Optional: describing a pipeline then falls back to
	// Tools, which can run version checks.
	Known    func(depID string) (core.DepStatus, bool)
	Settings func() core.Settings
	Clock    func() time.Time // tests; nil = time.Now
	// Location is the zone schedules are read in; nil = time.Local (tests).
	Location *time.Location

	// ProtectedDirs are folders a watch folder may not be inside (the support
	// and tools directories). Optional.
	ProtectedDirs []string

	// TmpDir is <support>/tmp; text copied to the clipboard becomes a .txt in
	// <TmpDir>/clipboard-runs for the run it starts. Optional: without it a
	// text trigger can't start runs.
	TmpDir string
	// ClipboardOn reports whether clipboard recording is on right now. The
	// "When I copy…" trigger fires only while it is. Optional: nil = never.
	ClipboardOn func() bool
}

// DepsChanged re-sends the pipelines list after a dependency's state changed
// (wire it with deps.Service.OnChange): each pipeline's Check.Missing is
// derived from the cached dependency statuses.
func (r *Runner) DepsChanged() {
	r.mu.Lock()
	started := r.started
	r.mu.Unlock()
	if !started {
		return
	}
	r.emitPipelines()
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
	aliases   map[string]string // old step type ID -> its replacement
	needsYou  func(total int, firstRunName string)
	started   bool
	stopped   bool
	stopFuncs []func()
	finished  []func(core.PipelineRun)

	// Pipelines (guarded by pmu).
	pmu      sync.RWMutex
	pipes    []core.Pipeline
	lastRun  map[string]core.RunBrief
	watchMsg map[string]string
	schedMsg map[string]string // schedule messages (guarded by pmu)
	loadOnce sync.Once
	loadErr  error

	// The loop.
	inbox    chan func()
	quit     chan struct{}
	loopDone chan struct{}
	running  atomic.Bool
	wg       sync.WaitGroup
	l        *loop

	obsMu  sync.Mutex
	obsQ   []core.Job
	obsSig chan struct{}

	// Watch folders.
	schedMu   sync.Mutex       // one schedule pass at a time
	schedKick chan bool        // wake the schedule goroutine; true = catch up
	schedLast map[string]int64 // last fire per pipeline when there is no store (guarded by schedMu)

	watchMu sync.Mutex
	watch   map[string]*watchTrack

	// Tunables (tests shrink them).
	waitRetry     time.Duration
	emitEvery     time.Duration
	persistEvery  time.Duration
	watchEvery    time.Duration
	wallEvery     time.Duration
	stableAge     time.Duration
	maxStateBytes int
}

// New builds a Runner; nothing runs until Start.
func New(cfg Config) *Runner {
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.Em == nil {
		cfg.Em = core.NopEmitter{}
	}
	if cfg.Settings == nil {
		cfg.Settings = func() core.Settings { return core.Settings{Concurrency: core.DefaultConcurrency} }
	}
	return &Runner{
		cfg:           cfg,
		aliases:       map[string]string{},
		lastRun:       map[string]core.RunBrief{},
		watchMsg:      map[string]string{},
		schedMsg:      map[string]string{},
		schedKick:     make(chan bool, 1),
		inbox:         make(chan func(), 64),
		quit:          make(chan struct{}),
		loopDone:      make(chan struct{}),
		obsSig:        make(chan struct{}, 1),
		watch:         map[string]*watchTrack{},
		waitRetry:     WaitRetry,
		emitEvery:     RunEventInterval,
		persistEvery:  250 * time.Millisecond,
		watchEvery:    WatchInterval,
		wallEvery:     WallCheckEvery,
		stableAge:     3 * time.Second,
		maxStateBytes: MaxRunStateBytes,
	}
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

// RegisterAlias lets saved pipelines and runs that use the step type old keep
// working after its type became canonical (Local Chat's step was the built-in
// "pipelines.chat"). The alias is not listed in the catalogue, and saving a
// pipeline rewrites it to the canonical ID.
func (r *Runner) RegisterAlias(old, canonical string) {
	r.mu.Lock()
	r.aliases[old] = canonical
	r.mu.Unlock()
}

// OnNeedsYou is called (from the loop) whenever the total of NeedsYou over
// active runs changes; main.go wires it to the tray.
func (r *Runner) OnNeedsYou(fn func(total int, firstRunName string)) {
	r.mu.Lock()
	r.needsYou = fn
	r.mu.Unlock()
}

func (r *Runner) needsYouFn() func(int, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.needsYou
}

func (r *Runner) now() time.Time { return r.cfg.Clock() }

func (r *Runner) nowMs() int64 { return r.cfg.Clock().UnixMilli() }

// Start loads pipelines and active runs, reconciles them with their jobs,
// starts observing jobs and polling watch folders. Call after Jobs.Start.
func (r *Runner) Start(ctx context.Context) error {
	r.mu.Lock()
	if r.started || r.stopped {
		r.mu.Unlock()
		return nil
	}
	r.started = true
	r.mu.Unlock()

	if err := r.ensureLoaded(); err != nil {
		return err
	}
	lctx, cancel := context.WithCancel(ctx)
	l := newLoop(r, lctx)
	// Observe before restoring so no job update is missed; the queue is
	// drained by the loop after the reconcile.
	var stopObs func()
	if r.cfg.Jobs != nil {
		stopObs = r.cfg.Jobs.Observe(r.enqueue)
	}
	if err := l.restore(); err != nil {
		if stopObs != nil {
			stopObs()
		}
		cancel()
		return err
	}
	r.l = l
	r.mu.Lock()
	if stopObs != nil {
		r.stopFuncs = append(r.stopFuncs, stopObs)
	}
	r.stopFuncs = append(r.stopFuncs, cancel)
	r.mu.Unlock()
	r.pruneSeen()
	r.pruneClipRuns()
	r.running.Store(true)
	r.wg.Add(1)
	go l.run()
	r.startWatch(lctx)
	r.startSchedule(lctx)
	slog.Debug("pipelines runner started")
	return nil
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
	close(r.quit)
	r.wg.Wait()
	for _, f := range fns {
		f()
	}
}

// enqueue is the Jobs.Observe callback: it never blocks.
func (r *Runner) enqueue(j core.Job) {
	r.obsMu.Lock()
	r.obsQ = append(r.obsQ, j)
	r.obsMu.Unlock()
	select {
	case r.obsSig <- struct{}{}:
	default:
	}
}

func (r *Runner) takeObserved() []core.Job {
	r.obsMu.Lock()
	q := r.obsQ
	r.obsQ = nil
	r.obsMu.Unlock()
	return q
}

// exec runs fn on the loop goroutine and waits for it.
func (r *Runner) exec(fn func()) error {
	if !r.running.Load() {
		return core.Errorf(core.CodeInternal, "Pipelines aren't running")
	}
	done := make(chan struct{})
	job := func() { fn(); close(done) }
	select {
	case r.inbox <- job:
	case <-r.loopDone:
		return core.Errorf(core.CodeInternal, "Pipelines are shutting down")
	}
	select {
	case <-done:
		return nil
	case <-r.loopDone:
		select {
		case <-done:
			return nil
		default:
			return core.Errorf(core.CodeInternal, "Pipelines are shutting down")
		}
	}
}

// post queues fn for the loop from another goroutine; it gives up when the
// runner is stopping.
func (r *Runner) post(fn func()) {
	select {
	case r.inbox <- fn:
	case <-r.quit:
	case <-r.loopDone:
	}
}
