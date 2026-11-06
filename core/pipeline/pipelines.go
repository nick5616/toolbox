package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"regexp"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

var stepIDRe = regexp.MustCompile(`^[a-z0-9]{8}$`)

const idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func newStepID() string {
	b := make([]byte, 8)
	for i := range b {
		b[i] = idAlphabet[rand.IntN(len(idAlphabet))]
	}
	return string(b)
}

// ensureLoaded reads the saved pipelines once.
func (r *Runner) ensureLoaded() error {
	r.loadOnce.Do(func() {
		if r.cfg.Store == nil {
			return
		}
		ps, err := r.cfg.Store.ListPipelines(context.Background())
		if err != nil {
			r.loadErr = fmt.Errorf("loading pipelines: %w", err)
			return
		}
		r.pmu.Lock()
		r.pipes = ps
		r.pmu.Unlock()
	})
	return r.loadErr
}

func (r *Runner) snapshotPipes() []core.Pipeline {
	_ = r.ensureLoaded()
	r.pmu.RLock()
	defer r.pmu.RUnlock()
	return append([]core.Pipeline{}, r.pipes...)
}

func clonePipeline(p core.Pipeline) core.Pipeline {
	p.Steps = cloneSteps(p.Steps)
	return p
}

// List returns every pipeline with its check, watch state and last run.
func (r *Runner) List() []core.PipelineEntry {
	ps := r.snapshotPipes()
	out := make([]core.PipelineEntry, 0, len(ps))
	for _, p := range ps {
		out = append(out, r.entry(p))
	}
	return out
}

func (r *Runner) entry(p core.Pipeline) core.PipelineEntry {
	p = clonePipeline(p)
	check := r.Describe(p)
	e := core.PipelineEntry{Pipeline: p, Check: check, Watch: r.watchState(p, check)}
	r.pmu.RLock()
	if b, ok := r.lastRun[p.ID]; ok {
		b := b
		e.LastRun = &b
	}
	r.pmu.RUnlock()
	return e
}

func (r *Runner) emitPipelines() {
	r.cfg.Em.Emit(core.EventPipelinesChanged, core.PipelinesChanged{Pipelines: r.List()})
}

// Get returns one pipeline.
func (r *Runner) Get(id string) (core.Pipeline, error) {
	for _, p := range r.snapshotPipes() {
		if p.ID == id {
			return clonePipeline(p), nil
		}
	}
	return core.Pipeline{}, core.Errorf(core.CodeNotFound, "Pipeline not found")
}

func fieldErr(field, msg string) error {
	return core.ValidationError(msg, map[string]string{field: msg})
}

// normalize checks the shape of p and fills IDs, defaults and empty slices.
func (r *Runner) normalize(p *core.Pipeline, others []core.Pipeline) error {
	p.Name = strings.TrimSpace(p.Name)
	if n := utf8.RuneCountInString(p.Name); n < 1 || n > 80 {
		return fieldErr("name", "The name must be 1–80 characters")
	}
	for _, o := range others {
		if o.ID != p.ID && strings.EqualFold(o.Name, p.Name) {
			return fieldErr("name", "Another pipeline already has that name")
		}
	}
	if utf8.RuneCountInString(p.Description) > 300 {
		return fieldErr("description", "The description is too long (300 characters at most)")
	}
	if len(p.Layout) > 32<<10 {
		return fieldErr("layout", "The canvas layout is too large")
	}
	if len(p.Steps) < 1 || len(p.Steps) > MaxSteps {
		return fieldErr("steps", fmt.Sprintf("A pipeline needs 1–%d steps", MaxSteps))
	}
	p.Steps = cloneSteps(p.Steps)
	used := map[string]bool{}
	for _, s := range p.Steps {
		if s.ID != "" {
			if !stepIDRe.MatchString(s.ID) || s.ID == FromInput || s.ID == FromNone {
				return fieldErr("steps", "A step has an invalid ID")
			}
			if used[s.ID] {
				return fieldErr("steps", "Two steps have the same ID")
			}
			used[s.ID] = true
		}
	}
	total := 0
	earlier := map[string]bool{}
	for i := range p.Steps {
		s := &p.Steps[i]
		if s.ID == "" {
			for {
				s.ID = newStepID()
				if !used[s.ID] && s.ID != FromInput && s.ID != FromNone {
					break
				}
			}
			used[s.ID] = true
		}
		if s.Type == "" {
			return fieldErr("steps", fmt.Sprintf("Step %d has no type", i+1))
		}
		if utf8.RuneCountInString(s.Label) > 60 {
			return fieldErr("steps", fmt.Sprintf("Step %d: the title is too long (60 characters at most)", i+1))
		}
		if utf8.RuneCountInString(s.Note) > 200 {
			return fieldErr("steps", fmt.Sprintf("Step %d: the note is too long (200 characters at most)", i+1))
		}
		if strings.TrimSpace(s.OptionsJSON) == "" {
			s.OptionsJSON = "{}"
		}
		if !json.Valid([]byte(s.OptionsJSON)) {
			return fieldErr("steps", fmt.Sprintf("Step %d: the options aren't valid JSON", i+1))
		}
		total += len(s.OptionsJSON)
		if s.From != FromInput && s.From != FromNone && !earlier[s.From] {
			return fieldErr("steps", fmt.Sprintf("Step %d must read from the input, nothing, or an earlier step", i+1))
		}
		earlier[s.ID] = true
		for k, e := range s.Filter.Exts {
			s.Filter.Exts[k] = strings.ToLower(e)
		}
	}
	if total > MaxOptionsBytes {
		return fieldErr("steps", "The steps' options are too big (1 MiB at most)")
	}
	return nil
}

// Save validates the shape (not the steps' problems: those only block
// running), fills IDs and times, persists and emits pipelines:changed.
func (r *Runner) Save(p core.Pipeline) (core.PipelineEntry, error) {
	if err := r.ensureLoaded(); err != nil {
		return core.PipelineEntry{}, err
	}
	p = clonePipeline(p)
	now := r.nowMs()
	r.pmu.Lock()
	idx := -1
	for i, o := range r.pipes {
		if o.ID == p.ID && p.ID != "" {
			idx = i
		}
	}
	if p.ID != "" && idx < 0 {
		r.pmu.Unlock()
		return core.PipelineEntry{}, core.Errorf(core.CodeNotFound, "Pipeline not found")
	}
	if idx < 0 && len(r.pipes) >= MaxPipelines {
		r.pmu.Unlock()
		return core.PipelineEntry{}, core.ValidationError(fmt.Sprintf("At most %d pipelines", MaxPipelines), nil)
	}
	if err := r.normalize(&p, r.pipes); err != nil {
		r.pmu.Unlock()
		return core.PipelineEntry{}, err
	}
	var old core.Pipeline
	if idx >= 0 {
		old = r.pipes[idx]
		p.CreatedAt = old.CreatedAt
	} else {
		p.ID = core.NewID()
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	if r.cfg.Store != nil {
		if err := r.cfg.Store.PutPipeline(context.Background(), p); err != nil {
			r.pmu.Unlock()
			return core.PipelineEntry{}, fmt.Errorf("saving pipeline: %w", err)
		}
	}
	if idx >= 0 {
		r.pipes[idx] = p
	} else {
		r.pipes = append(r.pipes, p)
	}
	delete(r.watchMsg, p.ID)
	r.pmu.Unlock()

	if p.Watch.Enabled && (idx < 0 || !old.Watch.Enabled || old.Watch.Folder != p.Watch.Folder) {
		r.baseline(p)
	}
	r.watchMu.Lock()
	delete(r.watch, p.ID)
	r.watchMu.Unlock()
	e := r.entry(p)
	r.emitPipelines()
	return e, nil
}

// Delete removes a pipeline (its runs keep going and stay in history).
func (r *Runner) Delete(id string) error {
	if err := r.ensureLoaded(); err != nil {
		return err
	}
	r.pmu.Lock()
	idx := -1
	for i, o := range r.pipes {
		if o.ID == id {
			idx = i
		}
	}
	if idx < 0 {
		r.pmu.Unlock()
		return core.Errorf(core.CodeNotFound, "Pipeline not found")
	}
	if r.cfg.Store != nil {
		if err := r.cfg.Store.DeletePipeline(context.Background(), id); err != nil && !core.IsCode(err, core.CodeNotFound) {
			r.pmu.Unlock()
			return err
		}
	}
	r.pipes = append(r.pipes[:idx], r.pipes[idx+1:]...)
	delete(r.lastRun, id)
	delete(r.watchMsg, id)
	r.pmu.Unlock()
	r.watchMu.Lock()
	delete(r.watch, id)
	r.watchMu.Unlock()
	r.emitPipelines()
	return nil
}

// Duplicate saves a copy named "<name> copy" (watching off).
func (r *Runner) Duplicate(id string) (core.PipelineEntry, error) {
	src, err := r.Get(id)
	if err != nil {
		return core.PipelineEntry{}, err
	}
	names := map[string]bool{}
	for _, p := range r.snapshotPipes() {
		names[strings.ToLower(p.Name)] = true
	}
	base := src.Name + " copy"
	name := base
	for i := 2; names[strings.ToLower(name)]; i++ {
		name = fmt.Sprintf("%s %d", base, i)
	}
	if utf8.RuneCountInString(name) > 80 {
		name = string([]rune(name)[:80])
	}
	src.ID, src.Name = "", name
	src.Watch.Enabled = false
	return r.Save(src)
}

// setLastRun records a run as its pipeline's latest when it is the newest.
func (r *Runner) setLastRun(pipelineID string, b core.RunBrief) bool {
	r.pmu.Lock()
	defer r.pmu.Unlock()
	cur, ok := r.lastRun[pipelineID]
	if ok && cur.CreatedAt > b.CreatedAt {
		return false
	}
	if ok && cur == b {
		return false
	}
	r.lastRun[pipelineID] = b
	return true
}

func logErr(what string, err error) {
	if err != nil {
		slog.Warn("pipelines: "+what, "err", err)
	}
}
