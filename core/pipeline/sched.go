package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"toolbox/core"
)

type cand struct {
	item, step int
	files      []core.RunFile
	note       string
}

func (l *loop) cap() int {
	n := l.r.cfg.Settings().Concurrency
	if n < 2 {
		n = 2
	}
	return n
}

// advance moves every item of a run as far as it can go: resolves skips,
// check and manual pauses and merges, then starts ready cells (deepest step
// first, then lower item index) up to the per-run cap.
func (l *loop) advance(rs *runState) {
	for iter := 0; iter < 100; iter++ {
		changed := l.tryMerge(rs)
		inflight := 0
		for _, it := range rs.r.Items {
			for _, c := range it.Cells {
				if isActiveCell(c.Status) {
					inflight++
				}
			}
		}
		var cands []cand
		for ii := 0; ii < len(rs.r.Items); ii++ {
			item := &rs.r.Items[ii]
			for si := 0; si < len(item.Cells); si++ {
				c := &item.Cells[si]
				if isGood(c.Status) {
					continue
				}
				if c.Status != core.CellPending {
					break
				}
				if item.Input != "" && rs.tIdx >= 0 && si == rs.tIdx {
					if rs.merged() {
						l.skipLate(rs, ii)
						changed = true
						break
					}
					break // waits for the merge
				}
				sr := rs.steps[si]
				if !sr.ok {
					l.failCell(rs, ii, si, core.Errorf(core.CodeValidation, "This step's tool isn't available"))
					changed = true
					break
				}
				files, note := l.inputsFor(rs, ii, si)
				switch {
				case sr.check || sr.manual:
					if len(files) == 0 {
						l.setCell(rs, ii, si, core.CellSkipped, "Nothing for this step")
						changed = true
						continue
					}
					l.waitCell(rs, ii, si, files, note)
					changed = true
				case !sr.manual && sr.ad == nil:
					l.failCell(rs, ii, si, core.Errorf(core.CodeValidation, "This step can't run on its own").WithHint("Switch on \"I'll do this step myself\""))
					changed = true
				default:
					if len(files) == 0 && !sr.info.NoFiles {
						msg := "Nothing for this step"
						if note != "" {
							msg += " · " + note
						}
						l.setCell(rs, ii, si, core.CellSkipped, msg)
						changed = true
						continue
					}
					cands = append(cands, cand{ii, si, files, note})
				}
				break
			}
		}
		sort.SliceStable(cands, func(a, b int) bool {
			if cands[a].step != cands[b].step {
				return cands[a].step > cands[b].step
			}
			return cands[a].item < cands[b].item
		})
		limit := l.cap()
		for _, c := range cands {
			if inflight >= limit {
				break
			}
			if l.startCell(rs, c) {
				inflight++
			} else {
				changed = true
			}
		}
		if !changed {
			return
		}
	}
}

// setCell sets a final or simple state on a cell.
func (l *loop) setCell(rs *runState, ii, si int, st core.CellStatus, msg string) {
	c := &rs.r.Items[ii].Cells[si]
	c.Status, c.Message = st, msg
	c.Wait = ""
	if isFinal(st) {
		c.FinishedAt = l.r.nowMs()
	}
	l.touch(rs)
}

// skipLate handles an item that reaches the together step after the merge.
func (l *loop) skipLate(rs *runState, ii int) {
	item := &rs.r.Items[ii]
	l.setCell(rs, ii, rs.tIdx, core.CellSkipped, "Finished after the files were gathered")
	for k := rs.tIdx + 1; k < len(item.Cells); k++ {
		if !isFinal(item.Cells[k].Status) || item.Cells[k].Status == core.CellBlocked {
			item.Cells[k].Status, item.Cells[k].Message = core.CellNone, ""
		}
	}
}

// tryMerge creates the merged item once every non-merged item has finished
// the cells before the first together step (SPEC.md §4.2 rule 5).
func (l *loop) tryMerge(rs *runState) bool {
	T := rs.tIdx
	if T < 0 || rs.merged() {
		return false
	}
	var cands []int
	for ii, it := range rs.r.Items {
		if it.Input == "" {
			continue
		}
		good := true
		for si := 0; si < T; si++ {
			st := it.Cells[si].Status
			if !isFinal(st) {
				return false // still in progress
			}
			if !isGood(st) {
				good = false
			}
		}
		if good && it.Cells[T].Status == core.CellPending {
			cands = append(cands, ii)
		}
	}
	if len(cands) == 0 {
		return false
	}
	idx := len(rs.r.Items)
	label := fmt.Sprintf("All %d files", len(cands))
	if len(cands) == 1 {
		label = "1 file"
	}
	cells := make([]core.RunCell, len(rs.r.Steps))
	for si, s := range rs.r.Steps {
		st := core.CellPending
		if si < T {
			st = core.CellNone
		}
		cells[si] = core.RunCell{StepID: s.ID, Status: st, JobIDs: []string{}, Inputs: []core.RunFile{}, Files: []core.RunFile{}}
	}
	merged := core.RunItem{
		Index: idx, Label: label, Merged: append([]int{}, cands...), MergedAt: rs.r.Steps[T].ID, Cells: cells,
		Vars: builtinVars(label, false, idx+1, rs.r.Name, time.UnixMilli(rs.r.CreatedAt)),
	}
	for _, ii := range cands {
		it := &rs.r.Items[ii]
		it.Cells[T].Status, it.Cells[T].Message = core.CellMerged, "Gathered into "+label
		it.Cells[T].FinishedAt = l.r.nowMs()
		for k := T + 1; k < len(it.Cells); k++ {
			if it.Cells[k].Status == core.CellPending {
				it.Cells[k].Status = core.CellNone
			}
		}
	}
	rs.r.Items = append(rs.r.Items, merged)
	l.touch(rs)
	return true
}

// sourceFiles are the files a cell's From points at, before filtering.
func (l *loop) sourceFiles(rs *runState, ii, si int) []core.RunFile {
	item := &rs.r.Items[ii]
	step := rs.r.Steps[si]
	switch step.From {
	case FromInput:
		if item.Input == "" {
			var out []core.RunFile
			for _, m := range item.Merged {
				out = append(out, inputRunFile(rs.r.Items[m].Input))
			}
			return out
		}
		return []core.RunFile{inputRunFile(item.Input)}
	case FromNone:
		return nil
	}
	j := rs.stepIndex(step.From)
	if j < 0 || j >= si {
		return nil
	}
	if item.Input == "" && j < rs.tIdx {
		var out []core.RunFile
		for _, m := range item.Merged {
			out = append(out, rs.r.Items[m].Cells[j].Files...)
		}
		return out
	}
	return item.Cells[j].Files
}

func matchFilter(f core.StepFilter, rf core.RunFile) bool {
	if len(f.Roles) > 0 {
		ok := false
		for _, r := range f.Roles {
			if strings.EqualFold(r, rf.Role) {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	if len(f.Kinds) > 0 && !slices.Contains(f.Kinds, rf.Kind) {
		return false
	}
	name := rf.Name
	if name == "" {
		name = filepath.Base(rf.Path)
	}
	if len(f.Exts) > 0 && !slices.Contains(f.Exts, strings.ToLower(filepath.Ext(name))) {
		return false
	}
	if f.Name != "" && !strings.Contains(strings.ToLower(name), strings.ToLower(f.Name)) {
		return false
	}
	return true
}

func acceptsFile(a core.Accepts, rf core.RunFile) bool {
	if isURL(rf.Path) {
		return a.URLs
	}
	if a.Any {
		return true
	}
	return slices.Contains(a.Extensions, strings.ToLower(filepath.Ext(rf.Path)))
}

// notAcceptedText is "not images" for the cell message.
func notAcceptedText(a core.Accepts) string {
	var names []string
	add := func(n string) {
		if !slices.Contains(names, n) {
			names = append(names, n)
		}
	}
	for _, e := range a.Extensions {
		switch core.KindForPath("x" + e) {
		case core.KindImage:
			add("images")
		case core.KindAudio:
			add("audio files")
		case core.KindVideo:
			add("videos")
		case core.KindDocument:
			add("documents")
		default:
			add("supported files")
		}
	}
	if a.URLs && len(names) == 0 {
		return "not links"
	}
	if len(names) == 0 {
		return "not supported"
	}
	return "not " + strings.Join(names, " or ")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// inputsFor applies the filter and then the step's Accepts (SPEC.md §4.2
// rule 3) and notes what was dropped.
func (l *loop) inputsFor(rs *runState, ii, si int) ([]core.RunFile, string) {
	src := l.sourceFiles(rs, ii, si)
	step := rs.r.Steps[si]
	acc := rs.steps[si].info.Accepts
	files := make([]core.RunFile, 0, len(src))
	byFilter, byAccept := 0, 0
	for _, f := range src {
		switch {
		case !matchFilter(step.Filter, f):
			byFilter++
		case !acceptsFile(acc, f):
			byAccept++
		default:
			files = append(files, f)
		}
	}
	var notes []string
	if byFilter > 0 {
		notes = append(notes, plural(byFilter, "file", "files")+" skipped: filtered out")
	}
	if byAccept > 0 {
		notes = append(notes, plural(byAccept, "file", "files")+" skipped: "+notAcceptedText(acc))
	}
	return files, strings.Join(notes, "; ")
}

func (l *loop) waitCell(rs *runState, ii, si int, files []core.RunFile, note string) {
	c := &rs.r.Items[ii].Cells[si]
	c.Status, c.Inputs, c.Message = core.CellWaiting, cloneFiles(files), note
	c.StartedAt = l.r.nowMs()
	if rs.steps[si].check {
		c.Wait = core.WaitCheck
	} else {
		c.Wait = core.WaitManual
	}
	l.touch(rs)
}

// failCell fails a cell with err and blocks the item's later cells.
func (l *loop) failCell(rs *runState, ii, si int, err error) {
	ae := core.AsAppError(err)
	if ae.Err != nil {
		slog.Warn("pipelines: cell failed", "run", rs.r.ID, "step", si, "err", ae)
	}
	c := &rs.r.Items[ii].Cells[si]
	c.Status, c.Wait = core.CellFailed, ""
	c.ErrorCode, c.Error, c.ErrorHint = ae.Code, ae.Message, ae.Hint
	c.FinishedAt = l.r.nowMs()
	l.blockAfter(rs, ii, si)
	l.touch(rs)
}

func (l *loop) blockAfter(rs *runState, ii, si int) {
	item := &rs.r.Items[ii]
	for k := si + 1; k < len(item.Cells); k++ {
		if item.Cells[k].Status == core.CellPending {
			item.Cells[k].Status = core.CellBlocked
			item.Cells[k].Message = "An earlier step didn't finish"
		}
	}
}

func (l *loop) unblockAfter(rs *runState, ii, si int) {
	item := &rs.r.Items[ii]
	for k := si + 1; k < len(item.Cells); k++ {
		if item.Cells[k].Status == core.CellBlocked {
			item.Cells[k].Status, item.Cells[k].Message = core.CellPending, ""
		}
	}
}

// itemView builds the StepItem a step sees for item ii.
func (l *loop) itemView(rs *runState, ii int, files []core.RunFile) core.StepItem {
	it := rs.r.Items[ii]
	return core.StepItem{Index: it.Index, Label: it.Label, Files: cloneFiles(files), Vars: copyVars(it.Vars)}
}

func (l *loop) buildRequest(rs *runState, ii, si int) core.StepRequest {
	step := rs.r.Steps[si]
	item := &rs.r.Items[ii]
	opts := json.RawMessage(step.OptionsJSON)
	if len(opts) == 0 {
		opts = json.RawMessage("{}")
	}
	secrets := map[string]string{}
	prefix := step.ID + "."
	for k, v := range rs.secrets {
		if strings.HasPrefix(k, prefix) {
			secrets[strings.TrimPrefix(k, prefix)] = v
		}
	}
	req := core.StepRequest{
		RunID: rs.r.ID, StepID: step.ID, Pipeline: rs.r.Name, Options: append(json.RawMessage{}, opts...),
		Item: l.itemView(rs, ii, item.Cells[si].Inputs), Secrets: secrets, Started: rs.r.CreatedAt,
	}
	if rs.steps[si].info.Together && item.Input == "" {
		for _, m := range item.Merged {
			files, _ := l.inputsFor(rs, m, si)
			req.Items = append(req.Items, l.itemView(rs, m, files))
		}
	}
	return req
}

// startCell begins preparing a cell. It reports false if the cell failed at
// once instead.
func (l *loop) startCell(rs *runState, c cand) bool {
	step := rs.r.Steps[c.step]
	sr := rs.steps[c.step]
	for _, s := range sr.info.Secrets {
		if rs.secrets[step.ID+"."+s.Key] == "" {
			l.failCell(rs, c.item, c.step, core.Errorf(core.CodeValidation, "Passwords aren't kept after a restart").WithHint("Start the run again"))
			return false
		}
	}
	if len(c.files) > MaxFilesPerCell {
		l.failCell(rs, c.item, c.step, core.Errorf(core.CodeValidation, "This step has too many files").WithHint(fmt.Sprintf("At most %d files per step", MaxFilesPerCell)))
		return false
	}
	cell := &rs.r.Items[c.item].Cells[c.step]
	cell.Status, cell.Inputs, cell.Message = core.CellPreparing, cloneFiles(c.files), c.note
	cell.Error, cell.ErrorCode, cell.ErrorHint = "", "", ""
	cell.StartedAt, cell.FinishedAt = l.r.nowMs(), 0
	l.spawnPrepare(rs, c.item, c.step)
	l.touch(rs)
	return true
}

func safePrepare(ctx context.Context, ad core.Chainable, req core.StepRequest) (jobs []core.StepJob, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = &core.AppError{Code: core.CodeInternal, Message: "Something went wrong", Err: fmt.Errorf("panic in PrepareStep: %v", p)}
		}
	}()
	return ad.PrepareStep(ctx, req)
}

func (l *loop) spawnPrepare(rs *runState, ii, si int) {
	r := l.r
	rt := rs.cellRT(ii, si)
	if rt.cancel != nil {
		rt.cancel()
	}
	rt.gen++
	gen := rt.gen
	ctx, cancel := context.WithCancel(l.ctx)
	rt.cancel, rt.preparing, rt.retryAt = cancel, true, time.Time{}
	req := l.buildRequest(rs, ii, si)
	ad := rs.steps[si].ad
	runID := rs.r.ID
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		jobs, err := safePrepare(ctx, ad, req)
		r.post(func() { l.onPrepared(runID, ii, si, gen, jobs, err) })
	}()
}

// reprepare retries a condition wait.
func (l *loop) reprepare(rs *runState, ii, si int) {
	c := &rs.r.Items[ii].Cells[si]
	if c.Status != core.CellWaiting || c.Wait != core.WaitCondition {
		return
	}
	l.spawnPrepare(rs, ii, si)
}

// invalidatePrepare cancels a prepare in flight.
func (l *loop) invalidatePrepare(rs *runState, ii, si int) {
	rt := rs.rt[[2]int{ii, si}]
	if rt == nil {
		return
	}
	if rt.cancel != nil {
		rt.cancel()
		rt.cancel = nil
	}
	rt.gen++
	rt.preparing = false
	rt.retryAt = time.Time{}
}

func (l *loop) onPrepared(runID string, ii, si, gen int, jobs []core.StepJob, err error) {
	rs := l.runs[runID]
	if rs == nil || ii >= len(rs.r.Items) {
		return
	}
	rt := rs.cellRT(ii, si)
	if rt.gen != gen {
		return
	}
	rt.preparing = false
	if rt.cancel != nil {
		rt.cancel()
		rt.cancel = nil
	}
	c := &rs.r.Items[ii].Cells[si]
	if c.Status != core.CellPreparing && !(c.Status == core.CellWaiting && c.Wait == core.WaitCondition) {
		return
	}
	if err != nil {
		if core.IsCode(err, core.CodeWaiting) {
			ae := core.AsAppError(err)
			c.Status, c.Wait, c.Message, c.ErrorHint = core.CellWaiting, core.WaitCondition, ae.Message, ae.Hint
			rt.retryAt = time.Now().Add(l.r.waitRetry)
			l.touch(rs)
			return
		}
		l.failCell(rs, ii, si, err)
		return
	}
	l.submit(rs, ii, si, jobs)
}

// submit turns prepared jobs into tagged jobs; no jobs passes the inputs on.
func (l *loop) submit(rs *runState, ii, si int, sjobs []core.StepJob) {
	step := rs.r.Steps[si]
	sr := rs.steps[si]
	c := &rs.r.Items[ii].Cells[si]
	c.Wait, c.Error, c.ErrorCode, c.ErrorHint = "", "", "", ""
	if len(sjobs) == 0 {
		files := cloneFiles(c.Inputs)
		for i := range files {
			if step.Keep {
				files[i].Temporary = false
			}
		}
		l.completeCell(rs, ii, si, files, nil)
		return
	}
	if rs.jobCount+len(sjobs) > MaxJobsPerRun {
		l.failCell(rs, ii, si, core.Errorf(core.CodeValidation, "This run is too big").WithHint(fmt.Sprintf("At most %d jobs per run", MaxJobsPerRun)))
		return
	}
	if l.r.cfg.Jobs == nil {
		l.failCell(rs, ii, si, core.Errorf(core.CodeInternal, "Jobs aren't available"))
		return
	}
	tag := core.PipelineTag{RunID: rs.r.ID, StepID: step.ID}
	var ids []string
	cancelAll := func() {
		for _, id := range ids {
			_ = l.r.cfg.Jobs.Cancel(id)
		}
	}
	for _, sj := range sjobs {
		var opts []byte = []byte("{}")
		if sj.Options != nil {
			b, err := json.Marshal(sj.Options)
			if err != nil {
				cancelAll()
				l.failCell(rs, ii, si, fmt.Errorf("encoding job options: %w", err))
				return
			}
			opts = b
		}
		made, err := l.r.cfg.Jobs.SubmitFor(l.ctx, sr.typ.ModuleID, sj.Inputs, string(opts), tag)
		for _, j := range made {
			ids = append(ids, j.ID)
		}
		if err != nil {
			cancelAll()
			l.failCell(rs, ii, si, err)
			return
		}
		if rs.jobCount+len(ids) > MaxJobsPerRun {
			cancelAll()
			l.failCell(rs, ii, si, core.Errorf(core.CodeValidation, "This run is too big").WithHint(fmt.Sprintf("At most %d jobs per run", MaxJobsPerRun)))
			return
		}
	}
	c.Status, c.JobIDs = core.CellRunning, ids
	rs.jobCount += len(ids)
	for _, id := range ids {
		l.jobCell[id] = cellRef{rs.r.ID, ii, si}
	}
	l.touch(rs)
}

// completeCell finishes a cell with files and variables.
func (l *loop) completeCell(rs *runState, ii, si int, files []core.RunFile, vars map[string]string) {
	item := &rs.r.Items[ii]
	c := &item.Cells[si]
	if len(files) > MaxFilesPerCell {
		l.failCell(rs, ii, si, core.Errorf(core.CodeValidation, "This step made too many files").WithHint(fmt.Sprintf("At most %d files per step", MaxFilesPerCell)))
		return
	}
	c.Status, c.Wait, c.Files = core.CellDone, "", files
	c.Error, c.ErrorCode, c.ErrorHint = "", "", ""
	c.FinishedAt = l.r.nowMs()
	mergeVars(item, vars)
	l.touch(rs)
}

// mergeVars adds step variables to an item (later values win), capped.
func mergeVars(item *core.RunItem, vars map[string]string) {
	if len(vars) == 0 {
		return
	}
	if item.Vars == nil {
		item.Vars = map[string]string{}
	}
	for k, v := range vars {
		if !core.VarName.MatchString(k) {
			continue
		}
		v, _ = core.CapVar(v)
		item.Vars[k] = v
	}
	fitVars(item.Vars)
}
