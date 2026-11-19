package mediaindex

import (
	"context"
	"encoding/json"
	"path/filepath"
	"time"

	"toolbox/core"
)

// The scheduler (SPEC.md §3.2): one hidden quiet job at a time, only when no
// other (non-quiet) job is queued or running, indexing is on and not paused,
// and the pack is installed. Pictures and text first, speech after.

// inflight is the job (or jobs) the scheduler submitted and is waiting for.
type inflight struct {
	ids       map[string]bool
	speech    bool
	solo      bool
	paths     []string
	cancelled bool // cancelled by the scheduler (a user job waited)
}

// onJob is the Jobs.Observe callback: it records our jobs' states and wakes
// the loop. It never blocks.
func (ix *Index) onJob(j core.Job) {
	ours := j.ModuleID == IndexModuleID || j.ModuleID == SpeechModuleID
	ix.mu.Lock()
	if ours {
		switch j.Status {
		case core.JobDone, core.JobFailed, core.JobCancelled:
			ix.finished[j.ID] = j
			delete(ix.latest, j.ID)
			if len(ix.finished) > 64 { // nothing waits for these forever
				for id := range ix.finished {
					if ix.inflight == nil || !ix.inflight.ids[id] {
						delete(ix.finished, id)
					}
					if len(ix.finished) <= 32 {
						break
					}
				}
			}
		default:
			ix.latest[j.ID] = j
		}
	}
	ix.mu.Unlock()
	ix.signal()
	if ours {
		ix.emitStatus()
	}
}

// loop is the scheduler goroutine.
func (ix *Index) loop(ctx context.Context) {
	first := time.NewTimer(ix.firstDelay)
	defer first.Stop()
	tick := time.NewTicker(ix.tickEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ix.rootCtx.Done():
			return
		case <-first.C:
			ix.startupReconcile(ctx)
			ix.tick(ctx)
		case <-tick.C:
			ix.tick(ctx)
		case <-ix.wake:
			ix.tick(ctx)
		}
	}
}

// startupReconcile is the first reconcile: failed rows (fewer than two
// attempts) get one more try, then the library is walked.
func (ix *Index) startupReconcile(ctx context.Context) {
	ix.mu.Lock()
	already := ix.reconciled
	ix.mu.Unlock()
	if already {
		return
	}
	_, _ = ix.cfg.Store.ResetFailed(ctx)
	ix.doReconcile(ctx)
}

func (ix *Index) doReconcile(ctx context.Context) {
	changed, err := ix.reconcile(ctx)
	ix.mu.Lock()
	ix.reconciled = true
	if err != nil && ctx.Err() == nil {
		ix.lastError = "Indexing stopped: " + err.Error()
	}
	ix.mu.Unlock()
	if changed {
		ix.emitStatus()
	}
}

// tick does everything due: requests from the API, library changes, then
// the scheduling decision.
func (ix *Index) tick(ctx context.Context) {
	if ctx.Err() != nil || ix.isClosed() {
		return
	}
	ix.mu.Lock()
	rescan := ix.rescanReq
	ix.rescanReq = false
	added := make([]string, 0, len(ix.addedQ))
	for p := range ix.addedQ {
		added = append(added, p)
	}
	ix.addedQ = map[string]bool{}
	projects := ix.projDirty && !ix.clock().Before(ix.projDue)
	if projects {
		ix.projDirty = false
	}
	ix.mu.Unlock()

	if rescan {
		ix.doReconcile(ctx)
	} else if len(added) > 0 {
		if err := ix.syncPaths(ctx, added); err == nil {
			ix.emitStatus()
		}
	}
	if projects {
		_ = ix.syncProjects(ctx)
		ix.emitStatus()
	}
	if ix.vec.idleFor(ix.clock()) > matrixIdle {
		ix.vec.drop()
	}
	ix.schedule(ctx)
}

// takeFinished returns the terminal snapshots of the inflight jobs when every
// one of them has finished.
func (ix *Index) takeFinished() ([]core.Job, bool) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.inflight == nil {
		return nil, false
	}
	var out []core.Job
	for id := range ix.inflight.ids {
		j, ok := ix.finished[id]
		if !ok {
			return nil, false
		}
		out = append(out, j)
	}
	for id := range ix.inflight.ids {
		delete(ix.finished, id)
	}
	return out, true
}

// schedule decides whether to submit a job now.
func (ix *Index) schedule(ctx context.Context) {
	s := ix.Settings()
	ix.mu.Lock()
	ready := ix.reconciled
	ix.mu.Unlock()
	if !ready || !s.Enabled || s.Paused || ix.cfg.Jobs == nil || ix.cfg.Installed == nil || !ix.cfg.Installed() {
		ix.setWaiting(false)
		return
	}

	// A job of ours is out: wait for it (or cancel speech for a waiting user job).
	ix.mu.Lock()
	inf := ix.inflight
	ix.mu.Unlock()
	if inf != nil {
		if jobs, done := ix.takeFinished(); done {
			ix.handleFinished(ctx, inf, jobs)
			ix.mu.Lock()
			ix.inflight = nil
			ix.mu.Unlock()
			ix.emitStatus()
		} else {
			ix.maybeCancelSpeech(ctx, inf)
			return
		}
	}

	ix.mu.Lock()
	backoff := ix.clock().Before(ix.backoffUntil)
	ix.mu.Unlock()
	if backoff {
		return
	}

	work, err := ix.nextWork(ctx, s)
	if err != nil || work == nil {
		ix.setWaiting(false)
		return
	}
	active, err := ix.cfg.Jobs.List(ctx, core.JobFilter{Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 500})
	if err != nil {
		return
	}
	for _, j := range active {
		if !j.Quiet && j.ModuleID != IndexModuleID && j.ModuleID != SpeechModuleID {
			ix.setWaiting(true) // work is pending but the user's jobs are running
			return
		}
		if j.ModuleID == IndexModuleID || j.ModuleID == SpeechModuleID {
			return // one of ours is already out (e.g. before a restart of the scheduler)
		}
	}
	ix.setWaiting(false)

	// Labels (the vocabulary's text vectors) load in the background first.
	if ix.labels.get() == nil || ix.labels.get().model.ID != ix.Model().ID {
		ix.startLabels()
		return
	}
	ix.maybeRecompute()
	ix.submit(ctx, work)
}

func (ix *Index) setWaiting(w bool) {
	ix.mu.Lock()
	changed := ix.waiting != w
	ix.waiting = w
	ix.mu.Unlock()
	if changed {
		ix.emitStatus()
	}
}

// work is what to submit.
type work struct {
	speech bool
	solo   bool
	paths  []string
	force  bool
}

// nextWork picks the next job: solo retries first, then a batch of pending
// pictures/text (newest first), then one speech file (smallest first).
func (ix *Index) nextWork(ctx context.Context, s core.SearchSettings) (*work, error) {
	ix.mu.Lock()
	solo := append([]string(nil), ix.solo...)
	ix.mu.Unlock()
	for _, p := range solo {
		if it, ok, err := ix.cfg.Store.GetItem(ctx, p); err == nil && ok && it.State == StatePending {
			return &work{solo: true, paths: []string{p}}, nil
		}
		ix.removeSolo(p) // done, gone or no longer pending
	}
	items, err := ix.cfg.Store.NextPending(ctx, BatchMaxFiles)
	if err != nil {
		return nil, err
	}
	if len(items) > 0 {
		w := &work{}
		for _, it := range items {
			w.paths = append(w.paths, it.Path)
		}
		return w, nil
	}
	if !s.Speech || ix.cfg.SpeechReady == nil || !ix.cfg.SpeechReady() {
		return nil, nil
	}
	sp, err := ix.cfg.Store.NextSpeech(ctx, 1)
	if err != nil || len(sp) == 0 {
		return nil, err
	}
	ix.mu.Lock()
	force := ix.force[sp[0].Path]
	ix.mu.Unlock()
	return &work{speech: true, paths: []string{sp[0].Path}, force: force}, nil
}

func (ix *Index) removeSolo(p string) {
	ix.mu.Lock()
	ix.removeSoloLocked(p)
	ix.mu.Unlock()
}

func (ix *Index) removeSoloLocked(p string) {
	for i, s := range ix.solo {
		if s == p {
			ix.solo = append(ix.solo[:i], ix.solo[i+1:]...)
			return
		}
	}
}

// submit starts the job for w.
func (ix *Index) submit(ctx context.Context, w *work) {
	module := IndexModuleID
	var opts any = BatchOptions{ReadText: ix.Settings().ReadText}
	if w.speech {
		module, opts = SpeechModuleID, SpeechOptions{Force: w.force}
	}
	raw, err := json.Marshal(opts)
	if err != nil {
		return
	}
	jobs, err := ix.cfg.Jobs.Submit(ctx, module, w.paths, string(raw))
	if err != nil || len(jobs) == 0 {
		ix.mu.Lock()
		if err != nil {
			ix.lastError = err.Error()
		}
		ix.backoffUntil = ix.clock().Add(ix.failPause)
		ix.mu.Unlock()
		return
	}
	inf := &inflight{ids: map[string]bool{}, speech: w.speech, solo: w.solo, paths: w.paths}
	ix.mu.Lock()
	for _, j := range jobs {
		inf.ids[j.ID] = true
		if _, done := ix.finished[j.ID]; !done {
			ix.latest[j.ID] = j
		}
	}
	ix.inflight = inf
	if w.speech {
		delete(ix.force, w.paths[0])
	}
	if w.solo {
		ix.removeSoloLocked(w.paths[0])
	}
	ix.lastError = ""
	ix.mu.Unlock()
	ix.emitStatus()
	ix.signal() // the job may already have finished
}

// maybeCancelSpeech cancels a running speech job when a user's job has waited
// too long; the file stays pending (no penalty).
func (ix *Index) maybeCancelSpeech(ctx context.Context, inf *inflight) {
	if !inf.speech || inf.cancelled {
		return
	}
	active, err := ix.cfg.Jobs.List(ctx, core.JobFilter{Statuses: []core.JobStatus{core.JobQueued}, Limit: 100})
	if err != nil {
		return
	}
	now := ix.clock().UnixMilli()
	for _, j := range active {
		if j.Quiet || j.ModuleID == IndexModuleID || j.ModuleID == SpeechModuleID {
			continue
		}
		if j.CreatedAt > 0 && now-j.CreatedAt > ix.userWait.Milliseconds() {
			inf.cancelled = true
			for id := range inf.ids {
				_ = ix.cfg.Jobs.Cancel(id)
			}
			return
		}
	}
}

// handleFinished applies the penalty rules once our job(s) ended: items the
// job didn't finish count as a failed attempt; a failed batch is retried
// item by item; an item that fails twice is skipped.
func (ix *Index) handleFinished(ctx context.Context, inf *inflight, jobs []core.Job) {
	stage := StagePictures
	if inf.speech {
		stage = StageSpeech
	}
	var failed bool
	var errMsg string
	var missing bool
	for _, j := range jobs {
		if j.Status == core.JobFailed {
			failed = true
			errMsg = j.Error
			if j.ErrorCode == core.CodeDependencyMissing {
				missing = true
			}
		}
	}
	// Items still pending after a job that ended on its own didn't make it.
	var left []string
	for _, p := range inf.paths {
		it, ok, err := ix.cfg.Store.GetItem(ctx, p)
		if err != nil || !ok {
			continue
		}
		st := it.State
		if inf.speech {
			st = it.SpeechState
		}
		if st == StatePending { // SpeechPending has the same value
			left = append(left, p)
		}
	}
	cancelled := inf.cancelled
	for _, j := range jobs {
		if j.Status == core.JobCancelled {
			cancelled = true
		}
	}
	if len(left) == 0 {
		return
	}
	if cancelled && !failed {
		return // no penalty: it stays pending
	}
	if missing {
		ix.mu.Lock()
		ix.lastError = errMsg
		ix.backoffUntil = ix.clock().Add(5 * time.Minute)
		ix.mu.Unlock()
		return
	}
	reason := "Couldn't be read by the engine"
	ix.mu.Lock()
	if errMsg != "" {
		ix.lastError = errMsg
	}
	ix.backoffUntil = ix.clock().Add(ix.failPause)
	ix.mu.Unlock()
	for _, p := range left {
		it, ok, err := ix.cfg.Store.GetItem(ctx, p)
		if err != nil || !ok {
			continue
		}
		if it.Attempts+1 >= 2 {
			skipped := StateSkipped
			if inf.speech {
				skipped = SpeechSkipped
			}
			_ = ix.cfg.Store.SetItemState(ctx, p, stage, skipped, reason, 1)
			continue
		}
		pending := StatePending
		if inf.speech {
			pending = SpeechPending
		}
		_ = ix.cfg.Store.SetItemState(ctx, p, stage, pending, "", 1)
		if !inf.speech && len(inf.paths) > 1 {
			ix.mu.Lock()
			ix.solo = append(ix.solo, filepath.Clean(p))
			ix.mu.Unlock()
		}
	}
}

// startLabels loads the vocabulary's vectors in the background (it may take
// a while the first time: the engine embeds every prompt once).
func (ix *Index) startLabels() {
	ix.mu.Lock()
	if ix.labelsBusy || ix.closed || ix.clock().Before(ix.labelsRetry) {
		ix.mu.Unlock()
		return
	}
	ix.labelsBusy = true
	ix.mu.Unlock()
	ix.wg.Add(1)
	go func() {
		defer ix.wg.Done()
		_, err := ix.ensureLabels(ix.bg())
		ix.mu.Lock()
		ix.labelsBusy = false
		if err != nil && ix.bg().Err() == nil {
			ix.lastError = err.Error()
			ix.labelsRetry = ix.clock().Add(ix.failPause)
		}
		ix.mu.Unlock()
		ix.signal()
	}()
}

// maybeRecompute redoes auto labels from stored vectors when the vocabulary
// (or model) changed since they were written.
func (ix *Index) maybeRecompute() {
	want := ix.vocabHash()
	if want == "" {
		return
	}
	if have, ok, _ := ix.cfg.Store.GetSetting(ix.bg(), vocabHashKey); ok && have == want {
		return
	}
	ix.mu.Lock()
	if ix.recomputing || ix.closed {
		ix.mu.Unlock()
		return
	}
	ix.recomputing = true
	ix.mu.Unlock()
	ix.wg.Add(1)
	go func() {
		defer ix.wg.Done()
		err := ix.recomputeLabels(ix.bg())
		ix.mu.Lock()
		ix.recomputing = false
		if err != nil && ix.bg().Err() == nil {
			ix.lastError = err.Error()
		}
		ix.mu.Unlock()
	}()
}
