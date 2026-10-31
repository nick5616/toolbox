package pipeline

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"toolbox/core"
)

// onJob handles one job snapshot from the observer.
func (l *loop) onJob(j core.Job) {
	ref, known := l.jobCell[j.ID]
	if !known {
		if j.PipelineRunID == "" {
			l.tryAdopt(j)
		}
		return
	}
	rs := l.runs[ref.run]
	if rs == nil || ref.item >= len(rs.r.Items) {
		return
	}
	l.jobs[j.ID] = j
	item := &rs.r.Items[ref.item]
	cell := &item.Cells[ref.step]
	sr := rs.steps[ref.step]

	// A downloader's job title becomes the item's label.
	if ref.step == 0 && item.Input != "" && isURL(item.Input) && rs.r.Steps[0].Type == "downloader" &&
		j.Title != "" && j.Title != item.Input && item.Label != j.Title {
		item.Label = j.Title
		item.Vars["item"] = j.Title
		item.Vars["name"] = j.Title
		l.touch(rs)
	}

	switch {
	case sr.manual:
		if cell.Status == core.CellWaiting && cell.Wait == core.WaitManual {
			l.maybeAutoContinue(rs, ref.item, ref.step)
		}
	case cell.Status == core.CellRunning:
		if j.Status.Finished() {
			l.evaluate(rs, ref.item, ref.step)
		}
	case (cell.Status == core.CellFailed || cell.Status == core.CellCancelled || cell.Status == core.CellDone) &&
		(j.Status == core.JobQueued || j.Status == core.JobRunning):
		l.resume(rs, ref, j)
	}
}

// resume handles a finished cell whose job went back to work (a retry from
// the tray): the cell runs again and its blocked successors wait.
func (l *loop) resume(rs *runState, ref cellRef, j core.Job) {
	// Verify with the manager: a stale queued snapshot must not undo a cell.
	if l.r.cfg.Jobs != nil {
		cur, err := l.r.cfg.Jobs.Get(context.Background(), j.ID)
		if err != nil || !(cur.Status == core.JobQueued || cur.Status == core.JobRunning) {
			return
		}
	}
	item := &rs.r.Items[ref.item]
	cell := &item.Cells[ref.step]
	if ref.step+1 < len(item.Cells) && item.Cells[ref.step+1].Status == core.CellMerged {
		return // already gathered; a retry here changes nothing
	}
	cell.Status, cell.Wait = core.CellRunning, ""
	cell.Error, cell.ErrorCode, cell.ErrorHint, cell.Message = "", "", "", ""
	cell.FinishedAt = 0
	l.unblockAfter(rs, ref.item, ref.step)
	rs.cancelled = false
	l.touch(rs)
}

// evaluate completes a running cell once all its jobs have finished
// (SPEC.md §8.2).
func (l *loop) evaluate(rs *runState, ii, si int) {
	cell := &rs.r.Items[ii].Cells[si]
	if cell.Status != core.CellRunning {
		return
	}
	jobs := make([]core.Job, 0, len(cell.JobIDs))
	for _, id := range cell.JobIDs {
		j, ok := l.job(id)
		if !ok || !j.Status.Finished() {
			return
		}
		jobs = append(jobs, j)
	}
	failed, cancelled := 0, 0
	var first *core.Job
	for i := range jobs {
		switch jobs[i].Status {
		case core.JobFailed:
			failed++
			if first == nil {
				first = &jobs[i]
			}
		case core.JobCancelled:
			cancelled++
		}
	}
	switch {
	case failed > 0:
		msg := first.Error
		if msg == "" {
			msg = "The job failed"
		}
		c := cell
		c.Status = core.CellFailed
		c.ErrorCode, c.Error, c.ErrorHint = first.ErrorCode, msg, first.ErrorHint
		if len(jobs) > 1 {
			c.Message = fmt.Sprintf("%d of %d jobs failed", failed, len(jobs))
		}
		c.FinishedAt = l.r.nowMs()
		l.blockAfter(rs, ii, si)
		l.touch(rs)
		return
	case cancelled > 0:
		cell.Status, cell.FinishedAt = core.CellCancelled, l.r.nowMs()
		l.blockAfter(rs, ii, si)
		l.touch(rs)
		return
	}
	files, vars, err := l.collect(rs, si, jobs, false)
	if err != nil {
		l.failCell(rs, ii, si, err)
		return
	}
	l.completeCell(rs, ii, si, files, vars)
}

// collect reads finished jobs back into run files and variables. When
// lenient, a StepOutputs error falls back to the generic outputs.
func (l *loop) collect(rs *runState, si int, jobs []core.Job, lenient bool) ([]core.RunFile, map[string]string, error) {
	step := rs.r.Steps[si]
	sr := rs.steps[si]
	files := []core.RunFile{}
	vars := map[string]string{}
	seen := map[string]bool{}
	for _, j := range jobs {
		var res core.StepResult
		if sr.ad != nil {
			var err error
			res, err = safeOutputs(sr.ad, j)
			if err != nil {
				if !lenient {
					return nil, nil, core.Errorf(core.CodeInternal, "Couldn't read what %s made", toolName(sr)).WithCause(err)
				}
				res = genericOutputs(j)
			}
		} else {
			res = genericOutputs(j)
		}
		for _, f := range res.Files {
			if f.Name == "" {
				f.Name = filepath.Base(f.Path)
			}
			if f.Kind == "" {
				f.Kind = core.KindForPath(f.Path)
			}
			if f.OutputID == "" {
				for _, o := range j.Outputs {
					if samePath(o.Path, f.Path) {
						f.OutputID = o.ID
					}
				}
			}
			f.Temporary = !step.Keep && f.OutputID != ""
			f.Missing = false
			k := pathKey(f.Path)
			if seen[k] {
				continue
			}
			seen[k] = true
			files = append(files, f)
		}
		for k, v := range res.Vars {
			vars[k] = v
		}
	}
	return files, vars, nil
}

func toolName(sr stepRT) string {
	if sr.typ.Name != "" {
		return sr.typ.Name
	}
	return "the tool"
}

func safeOutputs(ad core.Chainable, j core.Job) (res core.StepResult, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic in StepOutputs: %v", p)
		}
	}()
	return ad.StepOutputs(j)
}

func genericOutputs(j core.Job) core.StepResult {
	var res core.StepResult
	for _, o := range j.Outputs {
		kind := o.Kind
		if kind == "" {
			kind = core.KindForPath(o.Path)
		}
		res.Files = append(res.Files, core.RunFile{Path: o.Path, Name: o.Name, Kind: kind, OutputID: o.ID})
	}
	return res
}

// --- manual steps ---

// tryAdopt gives an untagged job to a waiting manual cell (SPEC.md §8.4).
func (l *loop) tryAdopt(j core.Job) {
	for _, rs := range l.activeRuns() {
		if rs.manual == 0 {
			continue
		}
		for ii := range rs.r.Items {
			for si := range rs.r.Items[ii].Cells {
				c := &rs.r.Items[ii].Cells[si]
				sr := rs.steps[si]
				if c.Status != core.CellWaiting || c.Wait != core.WaitManual || !sr.manual || sr.typ.ModuleID != j.ModuleID {
					continue
				}
				if j.CreatedAt < c.StartedAt-1000 || !sharesPath(c.Inputs, j.Inputs) {
					continue
				}
				if l.r.cfg.Jobs != nil {
					if err := l.r.cfg.Jobs.Tag(j.ID, core.PipelineTag{RunID: rs.r.ID, StepID: rs.r.Steps[si].ID}); err != nil {
						slog.Warn("pipelines: adopting job", "job", j.ID, "err", err)
						return
					}
				}
				j.PipelineRunID, j.PipelineStepID = rs.r.ID, rs.r.Steps[si].ID
				c.JobIDs = append(c.JobIDs, j.ID)
				rs.jobCount++
				l.jobCell[j.ID] = cellRef{rs.r.ID, ii, si}
				l.jobs[j.ID] = j
				l.touch(rs)
				l.maybeAutoContinue(rs, ii, si)
				return
			}
		}
	}
}

func sharesPath(files []core.RunFile, inputs []string) bool {
	for _, f := range files {
		for _, in := range inputs {
			if samePath(f.Path, in) {
				return true
			}
		}
	}
	return false
}

// adopted returns the cell's adopted jobs' latest snapshots.
func (l *loop) adopted(c *core.RunCell) []core.Job {
	var out []core.Job
	for _, id := range c.JobIDs {
		if j, ok := l.job(id); ok {
			out = append(out, j)
		}
	}
	return out
}

// maybeAutoContinue carries a manual cell on when an adopted job finished
// done with files and no other adopted job is active.
func (l *loop) maybeAutoContinue(rs *runState, ii, si int) {
	step := rs.r.Steps[si]
	c := &rs.r.Items[ii].Cells[si]
	if !step.AutoContinue || c.Status != core.CellWaiting || c.Wait != core.WaitManual {
		return
	}
	var done []core.Job
	for _, j := range l.adopted(c) {
		if !j.Status.Finished() {
			return
		}
		if j.Status == core.JobDone {
			done = append(done, j)
		}
	}
	anyFiles := false
	for _, j := range done {
		if len(j.Outputs) > 0 {
			anyFiles = true
		}
	}
	if !anyFiles {
		return
	}
	files, vars, _ := l.collect(rs, si, done, true)
	l.completeCell(rs, ii, si, files, vars)
}

// --- commands ---

func (l *loop) findCell(rs *runState, item int, stepID string) (int, error) {
	if item < 0 || item >= len(rs.r.Items) {
		return 0, core.Errorf(core.CodeNotFound, "Item not found")
	}
	si := rs.stepIndex(stepID)
	if si < 0 {
		return 0, core.Errorf(core.CodeNotFound, "Step not found")
	}
	return si, nil
}

func (l *loop) doContinue(req core.ContinueRequest) error {
	rs, err := l.getRun(req.RunID)
	if err != nil {
		return err
	}
	si, err := l.findCell(rs, req.Item, req.StepID)
	if err != nil {
		return err
	}
	c := &rs.r.Items[req.Item].Cells[si]
	if c.Status != core.CellWaiting || (c.Wait != core.WaitManual && c.Wait != core.WaitCheck) {
		return core.Errorf(core.CodeConflict, "That step isn't waiting for you")
	}
	step := rs.r.Steps[si]
	var files []core.RunFile
	var vars map[string]string
	switch {
	case c.Wait == core.WaitCheck:
		files = pickFiles(c.Inputs, req.Keep)
	case req.PassThrough:
		files = cloneFiles(c.Inputs)
	default:
		var done []core.Job
		for _, j := range l.adopted(c) {
			if j.Status == core.JobDone {
				done = append(done, j)
			}
		}
		all, v, _ := l.collect(rs, si, done, true)
		if len(all) == 0 {
			return core.Errorf(core.CodeConflict, "Nothing to continue with yet").WithHint("Run the tool first, or continue with the original file")
		}
		files, vars = pickFiles(all, req.Keep), v
	}
	if step.Keep {
		for i := range files {
			files[i].Temporary = false
		}
	}
	l.finishWait(rs, req.Item, si, files, vars, c.Wait == core.WaitCheck && len(files) == 0)
	return nil
}

// pickFiles returns the files whose paths are in keep (nil = all), in order.
func pickFiles(all []core.RunFile, keep []string) []core.RunFile {
	if keep == nil {
		return cloneFiles(all)
	}
	out := []core.RunFile{}
	for _, f := range all {
		for _, k := range keep {
			if samePath(f.Path, k) {
				out = append(out, f)
				break
			}
		}
	}
	return out
}

// finishWait completes a manual or check cell. keptNothing skips the item's
// remaining cells.
func (l *loop) finishWait(rs *runState, ii, si int, files []core.RunFile, vars map[string]string, keptNothing bool) {
	c := &rs.r.Items[ii].Cells[si]
	c.Wait = ""
	l.completeCell(rs, ii, si, files, vars)
	if keptNothing {
		c.Message = "You kept nothing"
		item := &rs.r.Items[ii]
		for k := si + 1; k < len(item.Cells); k++ {
			if item.Cells[k].Status == core.CellPending {
				item.Cells[k].Status, item.Cells[k].Message = core.CellSkipped, "You kept nothing"
			}
		}
	}
}

func (l *loop) doSkip(runID string, item int, stepID string) error {
	rs, err := l.getRun(runID)
	if err != nil {
		return err
	}
	si, err := l.findCell(rs, item, stepID)
	if err != nil {
		return err
	}
	c := &rs.r.Items[item].Cells[si]
	if c.Status != core.CellWaiting || (c.Wait != core.WaitManual && c.Wait != core.WaitCheck) {
		return core.Errorf(core.CodeConflict, "That step isn't waiting for you")
	}
	files := cloneFiles(c.Inputs)
	if rs.r.Steps[si].Keep {
		for i := range files {
			files[i].Temporary = false
		}
	}
	l.finishWait(rs, item, si, files, nil, false)
	c.Message = "Skipped"
	return nil
}

// cancelItem stops one item: active jobs are cancelled, waiting and
// preparing cells become cancelled and pending ones blocked.
func (l *loop) cancelItem(rs *runState, ii int) {
	item := &rs.r.Items[ii]
	for si := range item.Cells {
		c := &item.Cells[si]
		switch c.Status {
		case core.CellPreparing:
			l.invalidatePrepare(rs, ii, si)
			c.Status, c.FinishedAt = core.CellCancelled, l.r.nowMs()
		case core.CellRunning:
			l.cancelJobs(c)
		case core.CellWaiting:
			l.invalidatePrepare(rs, ii, si)
			l.cancelJobs(c)
			c.Status, c.Wait, c.FinishedAt = core.CellCancelled, "", l.r.nowMs()
		case core.CellPending:
			c.Status, c.Message = core.CellBlocked, "Stopped"
		}
	}
	l.touch(rs)
}

func (l *loop) cancelJobs(c *core.RunCell) {
	if l.r.cfg.Jobs == nil {
		return
	}
	for _, id := range c.JobIDs {
		if j, ok := l.job(id); ok && j.Status.Finished() {
			continue
		}
		_ = l.r.cfg.Jobs.Cancel(id)
	}
}

func (l *loop) doCancel(runID string) error {
	rs, err := l.getRun(runID)
	if err != nil {
		return err
	}
	if !isActiveRun(rs.r.Status) {
		return nil
	}
	rs.cancelled = true
	for ii := range rs.r.Items {
		l.cancelItem(rs, ii)
	}
	return nil
}

func (l *loop) doStopItem(runID string, item int) error {
	rs, err := l.getRun(runID)
	if err != nil {
		return err
	}
	if item < 0 || item >= len(rs.r.Items) {
		return core.Errorf(core.CodeNotFound, "Item not found")
	}
	l.cancelItem(rs, item)
	return nil
}

func (l *loop) doRetry(runID string) (core.PipelineRun, error) {
	rs, err := l.getRun(runID)
	if err != nil {
		return core.PipelineRun{}, err
	}
	if rs.r.Cleaned {
		return core.PipelineRun{}, core.Errorf(core.CodeConflict, "Its in-between files were deleted; start it again")
	}
	rs.cancelled = false
	for ii := range rs.r.Items {
		item := &rs.r.Items[ii]
		for si := range item.Cells {
			c := &item.Cells[si]
			switch c.Status {
			case core.CellFailed, core.CellCancelled:
				l.retryCell(rs, ii, si)
			case core.CellBlocked:
				c.Status, c.Message = core.CellPending, ""
			case core.CellWaiting:
				if c.Wait == core.WaitCondition {
					rt := rs.cellRT(ii, si)
					if !rt.preparing {
						l.reprepare(rs, ii, si)
					}
				}
			}
		}
	}
	rs.r.FinishedAt = 0
	l.touch(rs)
	l.settle()
	return cloneRun(rs.r, 300), nil
}

// retryCell retries a failed or cancelled cell's jobs, or makes it pending.
func (l *loop) retryCell(rs *runState, ii, si int) {
	c := &rs.r.Items[ii].Cells[si]
	retried := 0
	if l.r.cfg.Jobs != nil && !rs.steps[si].manual {
		for _, id := range c.JobIDs {
			j, ok := l.job(id)
			if !ok || (j.Status != core.JobFailed && j.Status != core.JobCancelled) {
				continue
			}
			nj, err := l.r.cfg.Jobs.Retry(context.Background(), id)
			if err != nil {
				slog.Debug("pipelines: retry job", "job", id, "err", err)
				continue
			}
			l.jobs[id] = nj
			retried++
		}
	}
	c.Error, c.ErrorCode, c.ErrorHint, c.Message, c.Wait = "", "", "", "", ""
	c.FinishedAt = 0
	if retried > 0 {
		c.Status = core.CellRunning
		l.unblockAfter(rs, ii, si)
		return
	}
	for _, id := range c.JobIDs {
		delete(l.jobCell, id)
		delete(l.jobs, id)
		rs.jobCount--
	}
	c.JobIDs, c.Inputs, c.Files = []string{}, []core.RunFile{}, []core.RunFile{}
	c.Status = core.CellPending
	l.invalidatePrepare(rs, ii, si)
	l.unblockAfter(rs, ii, si)
}
