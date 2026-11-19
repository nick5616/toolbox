package mediaindex

import (
	"context"
	"time"

	"toolbox/core"
)

// Test hooks for the external tests (compiled only into test binaries).

// TestKnobs sets the timing knobs, the matrix cap and the clock.
func (ix *Index) TestKnobs(userWait, failPause time.Duration, matrixLimit int64, now func() time.Time) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if userWait > 0 {
		ix.userWait = userWait
	}
	if failPause != 0 {
		ix.failPause = failPause
	}
	if matrixLimit > 0 {
		ix.matrixLimit = matrixLimit
	}
	if now != nil {
		ix.nowFn = now
	}
}

// TestLoad reads the settings like Start does, without starting the loop.
func (ix *Index) TestLoad(ctx context.Context) {
	s := ix.loadSettings(ctx)
	ix.mu.Lock()
	ix.settings = s
	ix.mu.Unlock()
}

// TestReconcile runs the startup reconcile (and marks the index reconciled).
func (ix *Index) TestReconcile(ctx context.Context) {
	ix.mu.Lock()
	first := !ix.reconciled
	ix.mu.Unlock()
	if first {
		ix.startupReconcile(ctx)
		return
	}
	ix.doReconcile(ctx) // a later reconcile (Rescan): failed rows are not reset
}

// TestTick runs one scheduler pass.
func (ix *Index) TestTick(ctx context.Context) { ix.tick(ctx) }

// TestJob delivers a job event as Jobs.Observe would.
func (ix *Index) TestJob(j core.Job) { ix.onJob(j) }

// TestWaitIdle waits for background goroutines (label loading, warming).
func (ix *Index) TestWaitIdle() { ix.wg.Wait() }

// TestPending lists how many solo retries are queued.
func (ix *Index) TestSolo() []string {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	return append([]string(nil), ix.solo...)
}

// TestRecompute runs the label recompute synchronously.
func (ix *Index) TestRecompute(ctx context.Context) error { return ix.recomputeLabels(ctx) }

// TestLabels loads the label set synchronously.
func (ix *Index) TestLabels(ctx context.Context) error {
	_, err := ix.ensureLabels(ctx)
	return err
}

// TestSyncPaths runs the library:added handling synchronously.
func (ix *Index) TestSyncPaths(ctx context.Context, paths ...string) error {
	return ix.syncPaths(ctx, paths)
}

// TestSyncProjects runs the project-saved handling synchronously.
func (ix *Index) TestSyncProjects(ctx context.Context) error { return ix.syncProjects(ctx) }

// TestMatrixStreaming reports whether scoring streams from SQLite.
func (ix *Index) TestMatrixStreaming() bool {
	ix.vec.rw.RLock()
	defer ix.vec.rw.RUnlock()
	return ix.vec.streaming
}
