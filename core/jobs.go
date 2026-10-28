package core

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Jobs is the job manager: queue, scheduler, cancellation, retry,
// persistence, and progress/log streaming. See SPEC.md §4.6.
//
// Scheduling begins at Start; Submit before Start only enqueues.
type Jobs struct {
	store      JobStore
	outputs    OutputStore
	reg        *Registry
	em         Emitter
	tools      func(depID string) (string, error)
	settings   func() Settings
	supportTmp string

	clk  clock
	prog *progressThrottle

	mu          sync.Mutex
	active      map[string]*activeJob // queued and running jobs
	queue       []*activeJob          // queued, ordered by CreatedAt then ID
	limit       int
	started     bool
	closing     bool
	root        context.Context
	rootCancel  context.CancelFunc
	lastCreated int64
	wg          sync.WaitGroup
}

// activeJob is the live state of a queued or running job. job is guarded by
// Jobs.mu; pmu serialises persist+emit of snapshots.
type activeJob struct {
	job    Job
	maxDet float64
	ctx    context.Context
	cancel context.CancelFunc
	log    *jobLog
	pmu    sync.Mutex
}

// NewJobs builds a manager. tools resolves dependency IDs to paths; settings
// returns the current settings (library dir, concurrency); supportTmp is the
// parent of per-job temp dirs.
func NewJobs(store JobStore, outputs OutputStore, reg *Registry, em Emitter, tools func(string) (string, error), settings func() Settings, supportTmp string) *Jobs {
	if supportTmp == "" {
		supportTmp = filepath.Join(os.TempDir(), "toolbox-tmp")
	}
	m := &Jobs{
		store: store, outputs: outputs, reg: reg, em: em, tools: tools,
		settings: settings, supportTmp: supportTmp,
		clk:    realClock{},
		active: map[string]*activeJob{},
		limit:  DefaultConcurrency,
		root:   context.Background(),
	}
	m.prog = newProgressThrottle(m.clk, progressInterval, func(p JobProgress) { m.em.Emit(EventJobsProgress, p) })
	return m
}

func clampConcurrency(n int) int {
	if n < MinConcurrency {
		return MinConcurrency
	}
	if n > MaxConcurrency {
		return MaxConcurrency
	}
	return n
}

func snap(j Job) Job {
	j.Outputs = append([]Output{}, j.Outputs...)
	if j.Inputs == nil {
		j.Inputs = []string{}
	}
	return j
}

// Start recovers interrupted jobs, clears supportTmp and starts scheduling.
func (m *Jobs) Start(ctx context.Context) error {
	if err := os.MkdirAll(m.supportTmp, 0o755); err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	entries, err := os.ReadDir(m.supportTmp)
	if err != nil {
		return fmt.Errorf("read temp dir: %w", err)
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(m.supportTmp, e.Name())); err != nil {
			slog.Warn("clean temp dir", "name", e.Name(), "err", err)
		}
	}

	running, err := m.store.ListJobs(ctx, JobFilter{Statuses: []JobStatus{JobRunning}, Limit: 500})
	if err != nil {
		return fmt.Errorf("list running jobs: %w", err)
	}
	for _, j := range running {
		j.Status = JobFailed
		j.ErrorCode = CodeInterrupted
		j.Error = "Interrupted when Toolbox quit"
		j.ErrorHint = "Retry to run it again"
		j.Message = ""
		j.FinishedAt = NowMillis()
		if err := m.store.UpdateJob(ctx, j); err != nil {
			return fmt.Errorf("mark job interrupted: %w", err)
		}
		m.em.Emit(EventJobsChanged, snap(j))
	}
	queued, err := m.store.ListJobs(ctx, JobFilter{Statuses: []JobStatus{JobQueued}, Limit: 500})
	if err != nil {
		return fmt.Errorf("list queued jobs: %w", err)
	}

	m.mu.Lock()
	m.root, m.rootCancel = context.WithCancel(ctx)
	m.limit = clampConcurrency(m.settings().Concurrency)
	for _, j := range queued {
		if _, dup := m.active[j.ID]; dup {
			continue
		}
		aj := &activeJob{job: j}
		m.active[j.ID] = aj
		m.queue = append(m.queue, aj)
		if j.CreatedAt > m.lastCreated {
			m.lastCreated = j.CreatedAt
		}
	}
	sortQueue(m.queue)
	m.started = true
	m.mu.Unlock()
	m.kick()
	return nil
}

func sortQueue(q []*activeJob) {
	sort.SliceStable(q, func(i, j int) bool {
		a, b := q[i].job, q[j].job
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		return a.ID < b.ID
	})
}

// Shutdown stops scheduling, cancels running jobs and waits up to timeout.
// It is idempotent.
func (m *Jobs) Shutdown(timeout time.Duration) error {
	m.mu.Lock()
	m.closing = true
	cancel := m.rootCancel
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	var err error
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		err = Errorf(CodeInternal, "Some jobs didn't stop within %s", timeout)
	}
	m.prog.Close()
	return err
}

// Submit validates and enqueues work for a module.
func (m *Jobs) Submit(ctx context.Context, moduleID string, inputs []string, optionsJSON string) ([]Job, error) {
	desc, ok := m.reg.Descriptor(moduleID)
	if !ok {
		return nil, Errorf(CodeNotFound, "Unknown module %q", moduleID)
	}
	mod, ok := m.reg.Get(moduleID)
	if !ok {
		return nil, ValidationError(desc.Name+" is coming soon", nil)
	}
	if desc.JobLess {
		return nil, ErrJobLess
	}
	clean := make([]string, 0, len(inputs))
	for _, in := range inputs {
		in = strings.TrimSpace(in)
		if in != "" && !slices.Contains(clean, in) {
			clean = append(clean, in)
		}
	}
	if desc.MaxInputs > 0 && len(clean) > desc.MaxInputs {
		return nil, ValidationError(fmt.Sprintf("At most %d files at a time", desc.MaxInputs),
			map[string]string{"inputs": fmt.Sprintf("At most %d files at a time", desc.MaxInputs)})
	}
	if strings.TrimSpace(optionsJSON) == "" {
		optionsJSON = "{}"
	}
	if !json.Valid([]byte(optionsJSON)) {
		return nil, ValidationError("Invalid options", nil)
	}
	if err := mod.Validate(clean, json.RawMessage(optionsJSON)); err != nil {
		return nil, err
	}

	var groups [][]string
	if desc.SplitInputs && len(clean) > 0 {
		for _, in := range clean {
			groups = append(groups, []string{in})
		}
	} else {
		groups = [][]string{clean}
	}

	m.mu.Lock()
	now := NowMillis()
	jobs := make([]Job, len(groups))
	for i, g := range groups {
		created := now
		if created <= m.lastCreated {
			created = m.lastCreated + 1
		}
		m.lastCreated = created
		title := desc.Name
		if len(g) > 0 {
			title = g[0]
		}
		jobs[i] = Job{
			ID: NewID(), ModuleID: moduleID, Title: title, Status: JobQueued,
			Inputs: g, OptionsJSON: optionsJSON, Attempt: 1, CreatedAt: created,
			Outputs: []Output{},
		}
	}
	m.mu.Unlock()

	for i, j := range jobs {
		if err := m.store.InsertJob(ctx, j); err != nil {
			ids := make([]string, 0, i)
			for _, d := range jobs[:i] {
				ids = append(ids, d.ID)
			}
			if len(ids) > 0 {
				_ = m.store.DeleteJobs(context.Background(), ids)
			}
			return nil, fmt.Errorf("save job: %w", err)
		}
	}

	m.mu.Lock()
	for _, j := range jobs {
		aj := &activeJob{job: j}
		m.active[j.ID] = aj
		m.queue = append(m.queue, aj)
	}
	sortQueue(m.queue)
	m.mu.Unlock()
	for _, j := range jobs {
		m.em.Emit(EventJobsChanged, snap(j))
	}
	m.kick()
	out := make([]Job, len(jobs))
	for i, j := range jobs {
		out[i] = snap(j)
	}
	return out, nil
}

// kick starts as many queued jobs as the limits allow.
func (m *Jobs) kick() {
	var start []*activeJob
	m.mu.Lock()
	if m.started && !m.closing {
		running := 0
		perMod := map[string]int{}
		for _, aj := range m.active {
			if aj.job.Status == JobRunning {
				running++
				perMod[aj.job.ModuleID]++
			}
		}
		var rest []*activeJob
		for _, aj := range m.queue {
			mod := aj.job.ModuleID
			if running >= m.limit {
				rest = append(rest, aj)
				continue
			}
			if d, ok := m.reg.Descriptor(mod); ok && d.MaxConcurrent > 0 && perMod[mod] >= d.MaxConcurrent {
				rest = append(rest, aj)
				continue
			}
			aj.job.Status = JobRunning
			aj.job.StartedAt = NowMillis()
			aj.ctx, aj.cancel = context.WithCancel(m.root)
			running++
			perMod[mod]++
			m.wg.Add(1)
			start = append(start, aj)
		}
		m.queue = rest
	}
	m.mu.Unlock()
	for _, aj := range start {
		go m.run(aj)
	}
}

// publish persists the latest snapshot of aj and emits it.
func (m *Jobs) publish(aj *activeJob) {
	aj.pmu.Lock()
	defer aj.pmu.Unlock()
	m.mu.Lock()
	s := snap(aj.job)
	m.mu.Unlock()
	if err := m.store.UpdateJob(context.Background(), s); err != nil {
		slog.Error("persist job", "job", s.ID, "err", err)
	}
	m.em.Emit(EventJobsChanged, s)
}

func (m *Jobs) update(aj *activeJob, fn func(j *Job)) {
	m.mu.Lock()
	fn(&aj.job)
	m.mu.Unlock()
	m.publish(aj)
}

func (m *Jobs) run(aj *activeJob) {
	defer m.wg.Done()
	m.publish(aj) // running

	m.mu.Lock()
	id := aj.job.ID
	ctx := aj.ctx
	m.mu.Unlock()

	seed, err := m.store.CountLogs(context.Background(), id)
	if err != nil {
		slog.Error("count job logs", "job", id, "err", err)
	}
	lg := newJobLog(id, seed, m.store, m.em, m.clk)
	m.mu.Lock()
	aj.log = lg
	m.mu.Unlock()

	runErr := m.execute(aj, lg)

	m.mu.Lock()
	cancelReq := aj.job.CancelRequested
	closing := m.closing
	aj.cancel()
	j := &aj.job
	j.FinishedAt = NowMillis()
	switch {
	case cancelReq:
		j.Status, j.Message = JobCancelled, ""
		j.ErrorCode, j.Error, j.ErrorHint = "", "", ""
	case runErr == nil:
		j.Status, j.Progress = JobDone, 1 // keep the module's last message, e.g. "Already up to date"
		j.ErrorCode, j.Error, j.ErrorHint = "", "", ""
	case closing && ctx.Err() != nil:
		j.Status, j.Message = JobFailed, ""
		j.ErrorCode, j.Error, j.ErrorHint = CodeInterrupted, "Interrupted when Toolbox quit", "Retry to run it again"
	default:
		ae := AsAppError(runErr)
		if ae.Err != nil {
			slog.Error("job failed", "job", id, "module", j.ModuleID, "err", ae)
		}
		j.Status, j.Message = JobFailed, ""
		j.ErrorCode, j.Error, j.ErrorHint = ae.Code, ae.Message, ae.Hint
	}
	m.mu.Unlock()

	lg.finish()
	m.prog.Forget(id)
	m.publish(aj)
	m.mu.Lock()
	delete(m.active, id)
	m.mu.Unlock()
	m.kick()
}

// execute prepares directories, runs the module and cleans up. Panics become
// CodeInternal errors.
func (m *Jobs) execute(aj *activeJob, lg *jobLog) (err error) {
	m.mu.Lock()
	job := snap(aj.job)
	ctx := aj.ctx
	m.mu.Unlock()

	tempDir := filepath.Join(m.supportTmp, job.ID)
	defer os.RemoveAll(tempDir)
	defer func() {
		if r := recover(); r != nil {
			slog.Error("job panicked", "job", job.ID, "module", job.ModuleID, "panic", r, "stack", string(debug.Stack()))
			lg.add(StreamSystem, fmt.Sprintf("internal error: %v", r))
			err = &AppError{Code: CodeInternal, Message: "Something went wrong", Err: fmt.Errorf("panic: %v", r)}
		}
	}()

	mod, ok := m.reg.Get(job.ModuleID)
	desc, _ := m.reg.Descriptor(job.ModuleID)
	if !ok {
		return ValidationError(desc.Name+" is unavailable", nil)
	}
	s := m.settings()
	outDir := ""
	if desc.OutputSubdir != "" {
		outDir = filepath.Join(s.LibraryDir, desc.OutputSubdir)
		if mkErr := os.MkdirAll(outDir, 0o755); mkErr != nil {
			return ValidationError("Library folder unavailable: "+s.LibraryDir, nil).WithCause(mkErr)
		}
	}
	if mkErr := os.MkdirAll(tempDir, 0o755); mkErr != nil {
		return fmt.Errorf("create temp dir: %w", mkErr)
	}

	hooks := JobHooks{
		Progress: func(pct float64, msg string) { m.reportProgress(aj, pct, msg) },
		Log:      lg.add,
		Title: func(title string) {
			m.update(aj, func(j *Job) { j.Title = title })
		},
		Output: func(path string) (Output, error) {
			o, e := NewOutput(path, job.ID, job.ModuleID)
			if e != nil {
				return Output{}, e
			}
			o, e = m.outputs.UpsertOutput(context.Background(), o)
			if e != nil {
				return Output{}, e
			}
			m.mu.Lock()
			if !slices.ContainsFunc(aj.job.Outputs, func(x Output) bool { return x.ID == o.ID }) {
				aj.job.Outputs = append(aj.job.Outputs, o)
			}
			m.mu.Unlock()
			m.em.Emit(EventLibraryAdded, o)
			m.publish(aj)
			return o, nil
		},
		Tool: m.tools,
		Result: func(r json.RawMessage) {
			m.update(aj, func(j *Job) { j.ResultJSON = string(r) })
		},
	}
	jc := NewJobContext(JobContext{
		ID: job.ID, ModuleID: job.ModuleID, Inputs: job.Inputs,
		Options: json.RawMessage(job.OptionsJSON), Attempt: job.Attempt,
		OutputDir: outDir, TempDir: tempDir,
	}, hooks)
	return mod.Run(ctx, jc)
}

func (m *Jobs) reportProgress(aj *activeJob, pct float64, msg string) {
	if math.IsNaN(pct) {
		return
	}
	m.mu.Lock()
	if pct < 0 {
		pct = IndeterminateProgress
	} else {
		pct = math.Min(pct, 1)
		pct = math.Max(pct, aj.maxDet)
		aj.maxDet = pct
	}
	aj.job.Progress, aj.job.Message = pct, msg
	id := aj.job.ID
	m.mu.Unlock()
	m.prog.Offer(JobProgress{ID: id, Progress: pct, Message: msg})
}

// overlay copies live state onto j. Caller holds m.mu.
func (m *Jobs) overlay(j *Job) {
	if aj, ok := m.active[j.ID]; ok {
		j.Progress, j.Message = aj.job.Progress, aj.job.Message
		j.CancelRequested, j.Title = aj.job.CancelRequested, aj.job.Title
		j.Outputs = append([]Output{}, aj.job.Outputs...)
		if aj.job.ResultJSON != "" {
			j.ResultJSON = aj.job.ResultJSON
		}
	}
}

// List returns jobs newest first.
func (m *Jobs) List(ctx context.Context, f JobFilter) ([]Job, error) {
	jobs, err := m.store.ListJobs(ctx, f)
	if err != nil {
		return nil, err
	}
	if jobs == nil {
		jobs = []Job{}
	}
	m.mu.Lock()
	for i := range jobs {
		m.overlay(&jobs[i])
	}
	m.mu.Unlock()
	return jobs, nil
}

// Get returns one job.
func (m *Jobs) Get(ctx context.Context, id string) (Job, error) {
	j, err := m.store.GetJob(ctx, id)
	if err != nil {
		return Job{}, err
	}
	m.mu.Lock()
	m.overlay(&j)
	m.mu.Unlock()
	return j, nil
}

// Cancel cancels a queued or running job.
func (m *Jobs) Cancel(id string) error {
	m.mu.Lock()
	aj, ok := m.active[id]
	if !ok {
		m.mu.Unlock()
		// Finished jobs are a no-op; unknown IDs are not_found.
		_, err := m.store.GetJob(context.Background(), id)
		return err
	}
	if aj.job.Status == JobQueued {
		m.queue = slices.DeleteFunc(m.queue, func(q *activeJob) bool { return q == aj })
		delete(m.active, id)
		aj.job.Status = JobCancelled
		aj.job.FinishedAt = NowMillis()
		aj.job.Message = ""
		m.mu.Unlock()
		m.publish(aj)
		return nil
	}
	aj.job.CancelRequested = true
	cancel := aj.cancel
	m.mu.Unlock()
	m.publish(aj)
	if cancel != nil {
		cancel()
	}
	return nil
}

// CancelAll cancels every queued and running job.
func (m *Jobs) CancelAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.active))
	for id := range m.active {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Cancel(id)
	}
}

// Retry re-queues a failed or cancelled job under the same ID.
func (m *Jobs) Retry(ctx context.Context, id string) (Job, error) {
	m.mu.Lock()
	_, busy := m.active[id]
	m.mu.Unlock()
	if busy {
		return Job{}, Errorf(CodeConflict, "That job is still active")
	}
	j, err := m.store.GetJob(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if j.Status != JobFailed && j.Status != JobCancelled {
		return Job{}, Errorf(CodeConflict, "Only failed or cancelled jobs can be retried")
	}
	j.Attempt++
	j.Status = JobQueued
	j.Progress, j.Message = 0, ""
	j.ErrorCode, j.Error, j.ErrorHint = "", "", ""
	j.StartedAt, j.FinishedAt = 0, 0
	j.CancelRequested = false
	j.ResultJSON = ""
	if err := m.store.UpdateJob(ctx, j); err != nil {
		return Job{}, err
	}
	n, err := m.store.CountLogs(ctx, id)
	if err != nil {
		return Job{}, err
	}
	line := LogLine{Seq: n + 1, TS: NowMillis(), Stream: StreamSystem, Text: fmt.Sprintf("── attempt %d ──", j.Attempt)}
	if err := m.store.AppendLogs(ctx, id, []LogLine{line}); err != nil {
		return Job{}, err
	}
	m.mu.Lock()
	aj := &activeJob{job: j}
	m.active[id] = aj
	m.queue = append(m.queue, aj)
	sortQueue(m.queue)
	s := snap(j)
	m.mu.Unlock()
	m.em.Emit(EventJobsLog, JobLogBatch{ID: id, Lines: []LogLine{line}})
	m.em.Emit(EventJobsChanged, s)
	m.kick()
	return s, nil
}

// Remove deletes a finished job and its logs (outputs stay in the library).
func (m *Jobs) Remove(ctx context.Context, id string) error {
	m.mu.Lock()
	_, busy := m.active[id]
	m.mu.Unlock()
	if busy {
		return Errorf(CodeConflict, "Cancel the job before removing it")
	}
	j, err := m.store.GetJob(ctx, id)
	if err != nil {
		return err
	}
	if !j.Status.Finished() {
		return Errorf(CodeConflict, "Cancel the job before removing it")
	}
	if err := m.store.DeleteJobs(ctx, []string{id}); err != nil {
		return err
	}
	m.em.Emit(EventJobsRemoved, JobsRemoved{IDs: []string{id}})
	return nil
}

// ClearFinished removes all finished jobs and returns how many.
func (m *Jobs) ClearFinished(ctx context.Context) (int, error) {
	total := 0
	for {
		jobs, err := m.store.ListJobs(ctx, JobFilter{Statuses: []JobStatus{JobDone, JobFailed, JobCancelled}, Limit: 500})
		if err != nil {
			return total, err
		}
		m.mu.Lock()
		var ids []string
		for _, j := range jobs {
			if _, busy := m.active[j.ID]; !busy {
				ids = append(ids, j.ID)
			}
		}
		m.mu.Unlock()
		if len(ids) == 0 {
			break
		}
		if err := m.store.DeleteJobs(ctx, ids); err != nil {
			return total, err
		}
		total += len(ids)
		m.em.Emit(EventJobsRemoved, JobsRemoved{IDs: ids})
	}
	return total, nil
}

// Logs returns the persisted log of a job plus lines not yet flushed.
func (m *Jobs) Logs(ctx context.Context, id string) ([]LogLine, error) {
	if _, err := m.store.GetJob(ctx, id); err != nil {
		return nil, err
	}
	m.mu.Lock()
	var lg *jobLog
	if aj, ok := m.active[id]; ok {
		lg = aj.log
	}
	m.mu.Unlock()
	if lg != nil {
		return lg.all()
	}
	lines, err := m.store.Logs(ctx, id)
	if lines == nil {
		lines = []LogLine{}
	}
	return lines, err
}

// SetConcurrency changes the global parallel-job limit (1–8) immediately.
func (m *Jobs) SetConcurrency(n int) {
	m.mu.Lock()
	m.limit = clampConcurrency(n)
	m.mu.Unlock()
	m.kick()
}

// HasActive reports whether any queued or running job belongs to moduleIDs.
func (m *Jobs) HasActive(moduleIDs ...string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, aj := range m.active {
		if slices.Contains(moduleIDs, aj.job.ModuleID) {
			return true
		}
	}
	return false
}
