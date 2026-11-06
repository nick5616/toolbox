package pipeline

import "toolbox/core"

// Phase 18 timing hooks. Wave 0 stubs; WP-T1 implements them.

// Resumed is called on a power resume: it checks every time wait and
// schedule against the wall clock now (Go's timers don't count sleep on
// Windows).
func (r *Runner) Resumed() {}

// WakeTimeWaits prepares every time-waiting cell again now, e.g. because a
// focus session ended early or was extended.
func (r *Runner) WakeTimeWaits() {}

// OnRunFinished registers fn, called on the loop goroutine once per run at
// its terminal transition (done, partial, failed, cancelled). fn must not
// block.
func (r *Runner) OnRunFinished(fn func(run core.PipelineRun)) { _ = fn }
