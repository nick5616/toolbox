package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"toolbox/core"
)

// StartRun preflights and starts a run (SPEC.md §8.3).
func (r *Runner) StartRun(req core.RunRequest, trigger string) (core.PipelineRun, error) {
	if trigger == "" {
		trigger = "manual"
	}
	p, err := r.Get(req.PipelineID)
	if err != nil {
		return core.PipelineRun{}, err
	}
	var inputs []string
	seen := map[string]bool{}
	for _, in := range req.Inputs {
		in = strings.TrimSpace(in)
		if in == "" || seen[in] {
			continue
		}
		seen[in] = true
		inputs = append(inputs, in)
	}
	if len(inputs) == 0 {
		return core.PipelineRun{}, core.ValidationError("Add at least one file", nil)
	}
	if len(inputs) > MaxItems {
		return core.PipelineRun{}, core.ValidationError(fmt.Sprintf("At most %d files per run", MaxItems), nil)
	}
	params, err := resolveParams(p, req.Params)
	if err != nil {
		return core.PipelineRun{}, err
	}
	check := r.Describe(p)
	if len(check.Missing) > 0 {
		return core.PipelineRun{}, core.Errorf(core.CodeDependencyMissing, "Needs %s", strings.Join(check.Missing, ", ")).
			WithHint("Install them in Settings → Tool packs")
	}
	if !check.Ready {
		msg := "This pipeline has problems"
		for i, sc := range check.Steps {
			if len(sc.Problems) > 0 {
				msg = fmt.Sprintf("Step %d: %s", i+1, sc.Problems[0])
				break
			}
		}
		if len(check.Problems) > 0 && msg == "This pipeline has problems" {
			msg = check.Problems[0]
		}
		return core.PipelineRun{}, core.ValidationError(msg, nil).WithHint("Fix the problems in the pipeline first")
	}
	secrets := map[string]string{}
	for _, ask := range check.Secrets {
		k := ask.StepID + "." + ask.Key
		if req.Secrets[k] == "" {
			return core.PipelineRun{}, core.ValidationError("Needs "+ask.Label, map[string]string{k: "Required"})
		}
		secrets[k] = req.Secrets[k]
	}

	// Which inputs does any input step accept?
	steps := resolveStepsFor(r, p.Steps)
	var accepted, left []string
	for _, in := range inputs {
		f := inputRunFile(in)
		ok := false
		for i, s := range p.Steps {
			if s.From == FromInput && matchFilter(s.Filter, f) && acceptsFile(steps[i].info.Accepts, f) {
				ok = true
			}
		}
		if ok {
			accepted = append(accepted, in)
		} else {
			left = append(left, in)
		}
	}
	if len(accepted) == 0 {
		return core.PipelineRun{}, core.ValidationError("This pipeline can't use these files", nil).
			WithHint("Drop files of a kind its first steps read")
	}
	note := ""
	if len(left) > 0 {
		names := make([]string, 0, 5)
		for i, in := range left {
			if i == 5 {
				names = append(names, fmt.Sprintf("and %d more", len(left)-5))
				break
			}
			names = append(names, inputLabel(in))
		}
		note = fmt.Sprintf("%s left out (no step reads them): %s", plural(len(left), "file", "files"), strings.Join(names, ", "))
	}

	var out core.PipelineRun
	var startErr error
	if err := r.exec(func() {
		out, startErr = r.l.newRun(p, accepted, trigger, note, secrets, params)
	}); err != nil {
		return core.PipelineRun{}, err
	}
	return out, startErr
}

func resolveStepsFor(r *Runner, steps []core.PipelineStep) []stepRT {
	l := &loop{r: r}
	return l.resolveSteps(steps)
}

func (l *loop) newRun(p core.Pipeline, inputs []string, trigger, note string, secrets, params map[string]string) (core.PipelineRun, error) {
	created := l.r.now()
	pr := core.PipelineRun{
		ID: core.NewID(), PipelineID: p.ID, Name: p.Name, Steps: cloneSteps(p.Steps),
		Status: core.RunRunning, Trigger: trigger, Inputs: append([]string{}, inputs...),
		Items: make([]core.RunItem, 0, len(inputs)), Error: note, CreatedAt: created.UnixMilli(),
	}
	for i, in := range inputs {
		label := inputLabel(in)
		cells := make([]core.RunCell, len(p.Steps))
		for si, s := range p.Steps {
			cells[si] = core.RunCell{StepID: s.ID, Status: core.CellPending, JobIDs: []string{}, Inputs: []core.RunFile{}, Files: []core.RunFile{}}
		}
		vars := builtinVars(label, isURL(in), i+1, p.Name, created)
		for k, v := range params { // run parameters (Phase 16); names never collide with built-ins
			vars[k] = v
		}
		pr.Items = append(pr.Items, core.RunItem{
			Index: i, Label: label, Input: in, Merged: []int{}, Cells: cells, Vars: vars,
		})
	}
	rs := &runState{r: pr, tIdx: -1, rt: map[[2]int]*cellRT{}, secrets: secrets}
	rs.steps = l.resolveSteps(pr.Steps)
	for i, st := range rs.steps {
		if st.ok && !st.manual && !st.check && st.info.Together {
			rs.tIdx = i
			break
		}
	}
	l.runs[pr.ID] = rs
	l.persist(rs)
	l.touch(rs)
	l.settle()
	return cloneRun(rs.r, 300), nil
}

// finishForWire caps variable previews and marks missing files.
func finishForWire(pr *core.PipelineRun) {
	exists := map[string]bool{}
	check := func(f *core.RunFile) {
		if isURL(f.Path) || f.Path == "" {
			return
		}
		ok, seen := exists[f.Path]
		if !seen {
			_, err := os.Stat(f.Path)
			ok = err == nil
			exists[f.Path] = ok
		}
		f.Missing = !ok
	}
	for i := range pr.Items {
		for k, v := range pr.Items[i].Vars {
			pr.Items[i].Vars[k] = truncRunes(v, 300)
		}
		for s := range pr.Items[i].Cells {
			c := &pr.Items[i].Cells[s]
			for f := range c.Inputs {
				check(&c.Inputs[f])
			}
			for f := range c.Files {
				check(&c.Files[f])
			}
		}
	}
}

func decodeRun(s string) (core.PipelineRun, error) {
	var pr core.PipelineRun
	if err := json.Unmarshal([]byte(s), &pr); err != nil {
		return pr, fmt.Errorf("decoding run: %w", err)
	}
	return cloneRun(pr, 0), nil
}

// live returns in-memory copies of the given runs (nil when not running).
func (r *Runner) live(ids []string) map[string]core.PipelineRun {
	out := map[string]core.PipelineRun{}
	if len(ids) == 0 {
		return out
	}
	_ = r.exec(func() {
		for _, id := range ids {
			if rs, ok := r.l.runs[id]; ok {
				out[id] = cloneRun(rs.r, 0)
			}
		}
	})
	return out
}

// Runs lists runs, newest first.
func (r *Runner) Runs(f core.RunFilter) ([]core.PipelineRun, error) {
	if r.cfg.Store == nil {
		return []core.PipelineRun{}, nil
	}
	states, err := r.cfg.Store.ListRuns(context.Background(), f)
	if err != nil {
		return nil, err
	}
	out := make([]core.PipelineRun, 0, len(states))
	var ids []string
	for _, s := range states {
		pr, err := decodeRun(s)
		if err != nil {
			continue
		}
		out = append(out, pr)
		ids = append(ids, pr.ID)
	}
	lv := r.live(ids)
	res := out[:0]
	for _, pr := range out {
		if cur, ok := lv[pr.ID]; ok {
			pr = cur
		}
		if f.ActiveOnly && !isActiveRun(pr.Status) {
			continue
		}
		finishForWire(&pr)
		res = append(res, pr)
	}
	return res, nil
}

// Run returns one run.
func (r *Runner) Run(id string) (core.PipelineRun, error) {
	if cur, ok := r.live([]string{id})[id]; ok {
		finishForWire(&cur)
		return cur, nil
	}
	if r.cfg.Store == nil {
		return core.PipelineRun{}, core.Errorf(core.CodeNotFound, "Run not found")
	}
	s, err := r.cfg.Store.GetRun(context.Background(), id)
	if err != nil {
		return core.PipelineRun{}, err
	}
	pr, err := decodeRun(s)
	if err != nil {
		return core.PipelineRun{}, err
	}
	finishForWire(&pr)
	return pr, nil
}

// cmd runs fn on the loop, returning its error.
func (r *Runner) cmd(fn func(l *loop) error) error {
	var cerr error
	if err := r.exec(func() { cerr = fn(r.l) }); err != nil {
		return err
	}
	return cerr
}

// Cancel cancels a run (SPEC.md §8.7).
func (r *Runner) Cancel(runID string) error {
	return r.cmd(func(l *loop) error { return l.doCancel(runID) })
}

// Retry retries a run's failed and cancelled cells.
func (r *Runner) Retry(runID string) (core.PipelineRun, error) {
	var out core.PipelineRun
	err := r.cmd(func(l *loop) error {
		var err error
		out, err = l.doRetry(runID)
		return err
	})
	return out, err
}

// Continue carries a waiting manual or check cell on.
func (r *Runner) Continue(req core.ContinueRequest) error {
	return r.cmd(func(l *loop) error { return l.doContinue(req) })
}

// SkipStep carries a waiting manual or check cell's inputs on unchanged.
func (r *Runner) SkipStep(runID string, item int, stepID string) error {
	return r.cmd(func(l *loop) error { return l.doSkip(runID, item, stepID) })
}

// StopItem cancels one item's active jobs; its later cells are blocked.
func (r *Runner) StopItem(runID string, item int) error {
	return r.cmd(func(l *loop) error { return l.doStopItem(runID, item) })
}

// CleanUp deletes a finished run's temporary files now.
func (r *Runner) CleanUp(runID string) (int, error) {
	n := 0
	err := r.cmd(func(l *loop) error {
		rs, err := l.getRun(runID)
		if err != nil {
			return err
		}
		if isActiveRun(rs.r.Status) {
			return core.Errorf(core.CodeConflict, "The run is still going")
		}
		n = l.cleanup(rs)
		l.persist(rs)
		l.emit(rs)
		return nil
	})
	return n, err
}

// Remove deletes a finished run (optionally its temporary files too).
func (r *Runner) Remove(runID string, deleteTemporary bool) error {
	return r.cmd(func(l *loop) error {
		rs, err := l.getRun(runID)
		if err != nil {
			return err
		}
		if isActiveRun(rs.r.Status) {
			return core.Errorf(core.CodeConflict, "Cancel the run before removing it")
		}
		if deleteTemporary && !rs.r.Cleaned {
			l.cleanup(rs)
		}
		if r.cfg.Store != nil {
			if err := r.cfg.Store.DeleteRuns(context.Background(), []string{runID}); err != nil {
				return err
			}
		}
		for _, it := range rs.r.Items {
			for _, c := range it.Cells {
				for _, id := range c.JobIDs {
					delete(l.jobCell, id)
					delete(l.jobs, id)
				}
			}
		}
		for _, c := range rs.rt {
			if c.cancel != nil {
				c.cancel()
			}
		}
		delete(l.runs, runID)
		r.cfg.Em.Emit(core.EventPipelinesRunsRemoved, core.RunsRemoved{IDs: []string{runID}})
		l.refreshLastRun(rs.r.PipelineID)
		return nil
	})
}

// refreshLastRun recomputes a pipeline's latest run after a removal.
func (l *loop) refreshLastRun(pipelineID string) {
	r := l.r
	r.pmu.Lock()
	delete(r.lastRun, pipelineID)
	r.pmu.Unlock()
	if r.cfg.Store != nil {
		states, err := r.cfg.Store.ListRuns(context.Background(), core.RunFilter{PipelineID: pipelineID, Limit: 1})
		if err == nil && len(states) > 0 {
			if pr, err := decodeRun(states[0]); err == nil {
				st := pr.Status
				if rs, ok := l.runs[pr.ID]; ok {
					st = rs.r.Status
				}
				r.setLastRun(pipelineID, core.RunBrief{ID: pr.ID, Status: st, CreatedAt: pr.CreatedAt})
			}
		}
	}
	r.emitPipelines()
}

var _ = time.Second
