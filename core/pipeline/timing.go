package pipeline

import (
	"log/slog"
	"time"

	"toolbox/core"
)

// Phase 18 timing (SPEC.md §3.1): time waits, the wall-clock check and the
// run-finished hook.

// WallCheckEvery is how often the loop compares time waits and schedules with
// the wall clock. Go's timers use the monotonic clock, which on Windows
// doesn't advance while the machine sleeps.
const WallCheckEvery = 30 * time.Second

// Resumed is called on a power resume: it checks every time wait and
// schedule against the wall clock now (Go's timers don't count sleep on
// Windows).
func (r *Runner) Resumed() {
	if !r.running.Load() {
		return
	}
	r.post(func() { r.l.checkTimeWaits(false) })
	r.kickSchedule(true)
}

// WakeTimeWaits prepares every time-waiting cell again now, e.g. because a
// focus session ended early or was extended.
func (r *Runner) WakeTimeWaits() {
	if !r.running.Load() {
		return
	}
	r.post(func() { r.l.checkTimeWaits(true) })
}

// OnRunFinished registers fn, called on the loop goroutine once per run at
// its terminal transition (done, partial, failed, cancelled). fn must not
// block.
func (r *Runner) OnRunFinished(fn func(run core.PipelineRun)) {
	if fn == nil {
		return
	}
	r.mu.Lock()
	r.finished = append(r.finished, fn)
	r.mu.Unlock()
}

// notifyFinished calls the OnRunFinished hooks (loop goroutine).
func (l *loop) notifyFinished(rs *runState) {
	l.r.mu.Lock()
	fns := append([]func(core.PipelineRun){}, l.r.finished...)
	l.r.mu.Unlock()
	if len(fns) == 0 {
		return
	}
	run := cloneRun(rs.r, 300)
	// The hooks run off the loop goroutine, so one that calls back into the
	// Runner (Run, Cancel, ...) can't deadlock the loop.
	l.r.wg.Add(1)
	go func() {
		defer l.r.wg.Done()
		for _, fn := range fns {
			func() {
				defer func() {
					if p := recover(); p != nil {
						slog.Error("pipelines: run-finished hook panicked", "panic", p)
					}
				}()
				fn(run)
			}()
		}
	}()
}

// retryAtFor converts a wall-clock deadline (Unix ms) into the loop's
// monotonic timer base. A deadline that has already passed retries after the
// ordinary condition delay, so a step that keeps answering "not yet" can't
// spin.
func (l *loop) retryAtFor(untilMs int64) time.Time {
	d := time.UnixMilli(untilMs).Sub(l.r.now())
	if d <= 0 {
		d = l.r.waitRetry
	}
	return time.Now().Add(d)
}

// checkTimeWaits prepares time-waiting cells again: those whose deadline has
// passed by the wall clock, or all of them when all is set.
func (l *loop) checkTimeWaits(all bool) {
	now := l.r.nowMs()
	for _, rs := range l.runs {
		if !isActiveRun(rs.r.Status) || rs.cancelled {
			continue
		}
		for ii := range rs.r.Items {
			for si := range rs.r.Items[ii].Cells {
				c := &rs.r.Items[ii].Cells[si]
				if c.Status != core.CellWaiting || c.Wait != core.WaitTime {
					continue
				}
				rt := rs.cellRT(ii, si)
				if !all && (rt.preparing || c.Until > now) {
					continue
				}
				l.spawnPrepare(rs, ii, si)
			}
		}
	}
}
