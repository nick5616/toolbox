package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"toolbox/core"
)

// loop owns every run. All of its methods run on the loop goroutine (or
// before it starts, in restore).
type loop struct {
	r   *Runner
	ctx context.Context

	runs    map[string]*runState
	jobs    map[string]core.Job // latest snapshot of jobs that belong to cells
	jobCell map[string]cellRef
	touched []*runState

	lastNeeds     int
	lastNeedsName string
}

func newLoop(r *Runner, ctx context.Context) *loop {
	return &loop{r: r, ctx: ctx, runs: map[string]*runState{}, jobs: map[string]core.Job{}, jobCell: map[string]cellRef{}}
}

func (l *loop) run() {
	r := l.r
	defer r.wg.Done()
	defer r.running.Store(false)
	defer close(r.loopDone)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()

	l.drainObserved()
	for _, rs := range l.runs {
		l.touch(rs)
	}
	l.settle()
	for {
		l.rearm(timer)
		select {
		case <-r.quit:
			l.shutdown()
			return
		case <-l.ctx.Done():
			l.shutdown()
			return
		case fn := <-r.inbox:
			fn()
		case <-r.obsSig:
			l.drainObserved()
		case <-timer.C:
			l.onTimer()
		}
		l.settle()
	}
}

func (l *loop) shutdown() {
	for _, rs := range l.runs {
		for _, c := range rs.rt {
			if c.cancel != nil {
				c.cancel()
			}
		}
		if !rs.persistDue.IsZero() || rs.touched {
			l.persist(rs)
		}
	}
}

func (l *loop) drainObserved() {
	for _, j := range l.r.takeObserved() {
		l.onJob(j)
	}
}

// touch marks a run changed; settle will advance, persist and emit it.
func (l *loop) touch(rs *runState) {
	if !rs.touched {
		rs.touched = true
		l.touched = append(l.touched, rs)
	}
}

// settle advances every touched run until nothing more changes, then updates
// status, persistence, events and the tray count.
func (l *loop) settle() {
	for len(l.touched) > 0 {
		batch := l.touched
		l.touched = nil
		for _, rs := range batch {
			rs.touched = false
			l.process(rs)
		}
	}
	l.updateNeeds()
}

func (l *loop) process(rs *runState) {
	if _, ok := l.runs[rs.r.ID]; !ok {
		return
	}
	if !rs.cancelled {
		l.advance(rs)
	}
	l.recompute(rs)
	l.markDirty(rs)
}

func isTerminalRun(s core.RunStatus) bool { return !isActiveRun(s) }

// recompute derives the run status, NeedsYou and FinishedAt (SPEC.md §8.3).
func (l *loop) recompute(rs *runState) {
	r := &rs.r
	needs, manual := 0, 0
	allFinal := true
	anyItem, okItems := false, 0
	for _, it := range r.Items {
		failed := false
		for _, c := range it.Cells {
			if !isFinal(c.Status) {
				allFinal = false
			}
			if c.Status == core.CellWaiting && (c.Wait == core.WaitManual || c.Wait == core.WaitCheck) {
				needs++
				if c.Wait == core.WaitManual {
					manual++
				}
			}
			if c.Status == core.CellFailed || c.Status == core.CellCancelled || c.Status == core.CellBlocked {
				failed = true
			}
		}
		anyItem = true
		if !failed {
			okItems++
		}
	}
	rs.manual = manual
	r.NeedsYou = needs
	old := r.Status
	switch {
	case rs.cancelled:
		r.Status = core.RunCancelled
	case allFinal && anyItem:
		switch {
		case okItems == len(r.Items):
			r.Status = core.RunDone
		case okItems == 0:
			r.Status = core.RunFailed
		default:
			r.Status = core.RunPartial
		}
	case needs > 0:
		r.Status = core.RunWaiting
	default:
		r.Status = core.RunRunning
	}
	if isTerminalRun(r.Status) {
		if r.FinishedAt == 0 {
			r.FinishedAt = l.r.nowMs()
		}
	} else {
		r.FinishedAt = 0
	}
	if r.Status == old && rs.lastStatus != "" {
		return
	}
	first := rs.lastStatus == ""
	rs.lastStatus = r.Status
	if isTerminalRun(r.Status) {
		if r.Status == core.RunDone && !r.Cleaned {
			n := l.cleanup(rs)
			slog.Debug("pipelines: run cleaned up", "run", r.ID, "files", n)
		}
		l.persist(rs)
		l.emit(rs)
	} else if !first {
		l.emit(rs)
	}
	if l.r.setLastRun(r.PipelineID, core.RunBrief{ID: r.ID, Status: r.Status, CreatedAt: r.CreatedAt}) {
		l.r.emitPipelines()
	}
}

// markDirty schedules the debounced persist and the throttled event.
func (l *loop) markDirty(rs *runState) {
	now := time.Now()
	if rs.persistDue.IsZero() {
		rs.persistDue = now.Add(l.r.persistEvery)
	}
	if now.Sub(rs.lastEmit) >= l.r.emitEvery {
		l.emit(rs)
	} else if rs.emitDue.IsZero() {
		rs.emitDue = rs.lastEmit.Add(l.r.emitEvery)
	}
}

func (l *loop) emit(rs *runState) {
	rs.lastEmit = time.Now()
	rs.emitDue = time.Time{}
	l.r.cfg.Em.Emit(core.EventPipelinesRun, cloneRun(rs.r, 300))
}

// stateJSON encodes the run, truncating variable values when it is too big.
func (l *loop) stateJSON(rs *runState) (string, error) {
	b, err := json.Marshal(rs.r)
	if err != nil {
		return "", err
	}
	if len(b) <= l.r.maxStateBytes {
		return string(b), nil
	}
	for _, cap := range []int{64 << 10, 8 << 10, 1 << 10, 256, 0} {
		c := rs.r
		c.Items = make([]core.RunItem, len(rs.r.Items))
		for i, it := range rs.r.Items {
			if cap == 0 {
				it.Vars = map[string]string{}
				c.Items[i] = it
				continue
			}
			c.Items[i] = cloneItem(it, 0, cap)
		}
		b, err = json.Marshal(c)
		if err != nil {
			return "", err
		}
		if len(b) <= l.r.maxStateBytes {
			return string(b), nil
		}
	}
	return string(b), nil
}

func (l *loop) persist(rs *runState) {
	rs.persistDue = time.Time{}
	if l.r.cfg.Store == nil {
		return
	}
	s, err := l.stateJSON(rs)
	if err != nil {
		slog.Error("pipelines: encode run", "run", rs.r.ID, "err", err)
		return
	}
	if err := l.r.cfg.Store.PutRun(context.Background(), rs.r, s); err != nil {
		slog.Error("pipelines: save run", "run", rs.r.ID, "err", err)
	}
}

// rearm sets the timer to the nearest deadline.
func (l *loop) rearm(t *time.Timer) {
	var next time.Time
	pick := func(d time.Time) {
		if !d.IsZero() && (next.IsZero() || d.Before(next)) {
			next = d
		}
	}
	for _, rs := range l.runs {
		pick(rs.persistDue)
		pick(rs.emitDue)
		for _, c := range rs.rt {
			if !c.preparing {
				pick(c.retryAt)
			}
		}
	}
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
	if next.IsZero() {
		t.Reset(time.Hour)
		return
	}
	d := time.Until(next)
	if d < time.Millisecond {
		d = time.Millisecond
	}
	t.Reset(d)
}

func (l *loop) onTimer() {
	now := time.Now()
	for _, rs := range l.runs {
		if !rs.emitDue.IsZero() && !now.Before(rs.emitDue) {
			l.emit(rs)
		}
		if !rs.persistDue.IsZero() && !now.Before(rs.persistDue) {
			l.persist(rs)
		}
		for k, c := range rs.rt {
			if c.retryAt.IsZero() || c.preparing || now.Before(c.retryAt) {
				continue
			}
			c.retryAt = time.Time{}
			l.reprepare(rs, k[0], k[1])
		}
	}
}

// updateNeeds calls the tray callback when the total or the first name changed.
func (l *loop) updateNeeds() {
	total := 0
	var first *runState
	for _, rs := range l.runs {
		if !isActiveRun(rs.r.Status) || rs.r.NeedsYou == 0 {
			continue
		}
		total += rs.r.NeedsYou
		if first == nil || rs.r.CreatedAt < first.r.CreatedAt || (rs.r.CreatedAt == first.r.CreatedAt && rs.r.ID < first.r.ID) {
			first = rs
		}
	}
	name := ""
	if first != nil {
		name = first.r.Name
	}
	if total == l.lastNeeds && name == l.lastNeedsName {
		return
	}
	l.lastNeeds, l.lastNeedsName = total, name
	if fn := l.r.needsYouFn(); fn != nil {
		fn(total, name)
	}
}

// --- loading runs ---

func (l *loop) resolveSteps(steps []core.PipelineStep) []stepRT {
	out := make([]stepRT, len(steps))
	for i, s := range steps {
		t, ad, ok := l.r.stepType(s.Type)
		rt := stepRT{typ: t, ad: ad, ok: ok, check: s.Type == CheckType}
		rt.manual = s.Manual && !rt.check
		switch {
		case !ok:
		case rt.check:
			rt.info = core.StepInfo{Accepts: core.Accepts{Any: true, Extensions: []string{}}}
		case rt.manual || ad == nil:
			rt.info = core.StepInfo{Accepts: t.Accepts}
		default:
			opts := json.RawMessage(s.OptionsJSON)
			if len(opts) == 0 {
				opts = json.RawMessage("{}")
			}
			info, err := ad.DescribeStep(opts)
			if err != nil {
				slog.Warn("pipelines: describe step", "step", s.Type, "err", err)
				info.Accepts = t.Accepts
			}
			rt.info = info
		}
		out[i] = rt
	}
	return out
}

// register adds a run to the loop, rebuilding its runtime state and
// reconciling cells with their jobs.
func (l *loop) register(pr core.PipelineRun) *runState {
	rs := &runState{r: pr, tIdx: -1, rt: map[[2]int]*cellRT{}}
	rs.steps = l.resolveSteps(pr.Steps)
	for i, st := range rs.steps {
		if st.ok && !st.manual && !st.check && st.info.Together {
			rs.tIdx = i
			break
		}
	}
	rs.cancelled = pr.Status == core.RunCancelled
	rs.lastStatus = pr.Status
	if rs.r.Inputs == nil {
		rs.r.Inputs = []string{}
	}
	for ii := range rs.r.Items {
		it := &rs.r.Items[ii]
		if it.Vars == nil {
			it.Vars = map[string]string{}
		}
		for si := range it.Cells {
			c := &it.Cells[si]
			for _, id := range c.JobIDs {
				l.jobCell[id] = cellRef{rs.r.ID, ii, si}
				rs.jobCount++
			}
			switch {
			case c.Status == core.CellPreparing, c.Status == core.CellRunning && len(c.JobIDs) == 0:
				c.Status, c.Inputs = core.CellPending, []core.RunFile{}
			case c.Status == core.CellWaiting && c.Wait == core.WaitCondition:
				rs.cellRT(ii, si).retryAt = time.Now()
			}
		}
	}
	l.runs[pr.ID] = rs
	// Reconcile: finished jobs complete their cells.
	for ii := range rs.r.Items {
		for si := range rs.r.Items[ii].Cells {
			c := &rs.r.Items[ii].Cells[si]
			if c.Status == core.CellRunning {
				l.evaluate(rs, ii, si)
			}
		}
	}
	if isActiveRun(rs.r.Status) {
		l.touch(rs)
	}
	return rs
}

// restore prunes history and loads the runs that were still going.
func (l *loop) restore() error {
	r := l.r
	if r.cfg.Store == nil {
		return nil
	}
	ctx := context.Background()
	if ids, err := r.cfg.Store.PruneRuns(ctx, KeepFinishedRuns); err != nil {
		logErr("prune runs", err)
	} else if len(ids) > 0 {
		r.cfg.Em.Emit(core.EventPipelinesRunsRemoved, core.RunsRemoved{IDs: ids})
	}
	states, err := r.cfg.Store.ListRuns(ctx, core.RunFilter{Limit: 200})
	if err != nil {
		return fmt.Errorf("loading runs: %w", err)
	}
	// ListRuns is newest first: the first run seen per pipeline is its last.
	seen := map[string]bool{}
	for _, s := range states {
		var pr core.PipelineRun
		if err := json.Unmarshal([]byte(s), &pr); err != nil {
			slog.Warn("pipelines: undecodable run", "err", err)
			continue
		}
		if !seen[pr.PipelineID] {
			seen[pr.PipelineID] = true
			r.pmu.Lock()
			r.lastRun[pr.PipelineID] = core.RunBrief{ID: pr.ID, Status: pr.Status, CreatedAt: pr.CreatedAt}
			r.pmu.Unlock()
		}
	}
	active, err := r.cfg.Store.ListRuns(ctx, core.RunFilter{ActiveOnly: true, Limit: 200})
	if err != nil {
		return fmt.Errorf("loading active runs: %w", err)
	}
	for _, s := range active {
		var pr core.PipelineRun
		if err := json.Unmarshal([]byte(s), &pr); err != nil {
			continue
		}
		l.register(pr)
	}
	return nil
}

// getRun finds a run in memory or loads it from the store.
func (l *loop) getRun(id string) (*runState, error) {
	if rs, ok := l.runs[id]; ok {
		return rs, nil
	}
	if l.r.cfg.Store == nil {
		return nil, core.Errorf(core.CodeNotFound, "Run not found")
	}
	s, err := l.r.cfg.Store.GetRun(context.Background(), id)
	if err != nil {
		return nil, err
	}
	var pr core.PipelineRun
	if err := json.Unmarshal([]byte(s), &pr); err != nil {
		return nil, fmt.Errorf("decoding run %s: %w", id, err)
	}
	return l.register(pr), nil
}

// activeRuns returns running and waiting runs, oldest first.
func (l *loop) activeRuns() []*runState {
	var out []*runState
	for _, rs := range l.runs {
		if isActiveRun(rs.r.Status) {
			out = append(out, rs)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].r.CreatedAt != out[j].r.CreatedAt {
			return out[i].r.CreatedAt < out[j].r.CreatedAt
		}
		return out[i].r.ID < out[j].r.ID
	})
	return out
}

// job returns the latest snapshot of a job (cached, else from the manager).
func (l *loop) job(id string) (core.Job, bool) {
	if j, ok := l.jobs[id]; ok {
		return j, true
	}
	if l.r.cfg.Jobs == nil {
		return core.Job{}, false
	}
	j, err := l.r.cfg.Jobs.Get(context.Background(), id)
	if err != nil {
		if core.IsCode(err, core.CodeNotFound) {
			// A removed job counts as cancelled.
			return core.Job{ID: id, Status: core.JobCancelled}, true
		}
		return core.Job{}, false
	}
	l.jobs[id] = j
	return j, true
}
