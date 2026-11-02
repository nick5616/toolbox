package pipeline

import (
	"encoding/json"
	"sort"

	"toolbox/core"
)

// stepType resolves a step type: its catalogue entry, its adapter (nil for
// check steps and manual-only modules) and whether it exists.
func (r *Runner) stepType(id string) (core.StepType, core.Chainable, bool) {
	r.mu.Lock()
	for _, b := range r.builtins {
		if b.t.ID == id {
			r.mu.Unlock()
			return b.t, b.a, true
		}
	}
	r.mu.Unlock()
	d, ok := r.cfg.Reg.Descriptor(id)
	if !ok || !stepCapable(d) {
		return core.StepType{}, nil, false
	}
	mod, _ := r.cfg.Reg.Get(id)
	ch, _ := mod.(core.Chainable)
	return moduleStepType(d, ch), ch, true
}

// stepCapable reports whether a module can be a step at all: ready, listed,
// runs jobs, and either reads something or is Chainable.
func stepCapable(d core.Descriptor) bool {
	if d.Status != core.StatusReady || d.Hidden || d.JobLess || d.NotAStep || d.ID == "pipelines" {
		return false
	}
	return d.Accepts.URLs || d.Accepts.Any || len(d.Accepts.Extensions) > 0
}

func moduleStepType(d core.Descriptor, ch core.Chainable) core.StepType {
	t := core.StepType{
		ID: d.ID, ModuleID: d.ID, Name: d.Name, Icon: d.Icon, Category: d.Category,
		Description: d.Tagline, Auto: ch != nil, Manual: true, Accepts: d.Accepts,
		DefaultsJSON: "{}",
	}
	if t.Accepts.Extensions == nil {
		t.Accepts.Extensions = []string{}
	}
	if ch != nil {
		if b, err := json.Marshal(ch.StepDefaults()); err == nil {
			t.DefaultsJSON = string(b)
		}
	}
	return t
}

// Catalog lists every step type: built-ins first (in registration order),
// then modules by descriptor order.
func (r *Runner) Catalog() []core.StepType {
	r.mu.Lock()
	out := make([]core.StepType, 0, len(r.builtins)+32)
	for _, b := range r.builtins {
		out = append(out, b.t)
	}
	r.mu.Unlock()
	ds := r.cfg.Reg.List()
	sort.SliceStable(ds, func(i, j int) bool { return ds[i].Order < ds[j].Order })
	for _, d := range ds {
		if !stepCapable(d) {
			continue
		}
		mod, _ := r.cfg.Reg.Get(d.ID)
		ch, _ := mod.(core.Chainable)
		out = append(out, moduleStepType(d, ch))
	}
	return out
}
