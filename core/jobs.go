package core

import (
	"context"
	"time"
)

// Jobs is the job manager: queue, scheduler, cancellation, retry,
// persistence, and progress/log streaming. See SPEC.md §4.6.
//
// CONTRACT STUB (foundation). WP-B replaces the bodies; exported signatures
// are frozen.
type Jobs struct {
	store      JobStore
	outputs    OutputStore
	reg        *Registry
	em         Emitter
	tools      func(depID string) (string, error)
	settings   func() Settings
	supportTmp string
}

// NewJobs builds a manager. tools resolves dependency IDs to paths; settings
// returns the current settings (library dir, concurrency); supportTmp is the
// parent of per-job temp dirs.
func NewJobs(store JobStore, outputs OutputStore, reg *Registry, em Emitter, tools func(string) (string, error), settings func() Settings, supportTmp string) *Jobs {
	return &Jobs{store: store, outputs: outputs, reg: reg, em: em, tools: tools, settings: settings, supportTmp: supportTmp}
}

// Start recovers interrupted jobs, clears supportTmp and starts scheduling.
func (m *Jobs) Start(ctx context.Context) error { return nil }

// Shutdown stops scheduling, cancels running jobs and waits up to timeout.
func (m *Jobs) Shutdown(timeout time.Duration) error { return nil }

// Submit validates and enqueues work for a module.
func (m *Jobs) Submit(ctx context.Context, moduleID string, inputs []string, optionsJSON string) ([]Job, error) {
	return nil, NotImplemented("Jobs.Submit")
}

// List returns jobs newest first.
func (m *Jobs) List(ctx context.Context, f JobFilter) ([]Job, error) { return []Job{}, nil }

// Get returns one job.
func (m *Jobs) Get(ctx context.Context, id string) (Job, error) {
	return Job{}, NotImplemented("Jobs.Get")
}

// Cancel cancels a queued or running job.
func (m *Jobs) Cancel(id string) error { return NotImplemented("Jobs.Cancel") }

// CancelAll cancels every queued and running job.
func (m *Jobs) CancelAll() {}

// Retry re-queues a failed or cancelled job under the same ID.
func (m *Jobs) Retry(ctx context.Context, id string) (Job, error) {
	return Job{}, NotImplemented("Jobs.Retry")
}

// Remove deletes a finished job and its logs (outputs stay in the library).
func (m *Jobs) Remove(ctx context.Context, id string) error { return NotImplemented("Jobs.Remove") }

// ClearFinished removes all finished jobs and returns how many.
func (m *Jobs) ClearFinished(ctx context.Context) (int, error) { return 0, nil }

// Logs returns the persisted log of a job.
func (m *Jobs) Logs(ctx context.Context, id string) ([]LogLine, error) { return []LogLine{}, nil }

// SetConcurrency changes the global parallel-job limit (1–8) immediately.
func (m *Jobs) SetConcurrency(n int) {}

// HasActive reports whether any queued or running job belongs to moduleIDs.
func (m *Jobs) HasActive(moduleIDs ...string) bool { return false }
