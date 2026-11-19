package pipeline

import (
	"encoding/json"
	"sort"

	"toolbox/core"
)

// stepType resolves a step type: its catalogue entry, its adapter (nil for
// check steps and manual-only modules) and whether it exists. An alias (an
// old built-in ID) resolves to the type that replaced it.
func (r *Runner) stepType(id string) (core.StepType, core.Chainable, bool) {
	r.mu.Lock()
	if canon, ok := r.aliases[id]; ok {
		id = canon
	}
	for _, b := range r.builtins {
		if b.t.ID == id {
			r.mu.Unlock()
			return b.t, b.a, true
		}
	}
	r.mu.Unlock()
	d, ok := r.cfg.Reg.Descriptor(id)
	if !ok {
		return core.StepType{}, nil, false
	}
	mod, _ := r.cfg.Reg.Get(id)
	return moduleStep(d, mod)
}

// canonicalType maps an alias to the step type that replaced it.
func (r *Runner) canonicalType(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if canon, ok := r.aliases[id]; ok {
		return canon
	}
	return id
}

// moduleStep resolves a module to its step type: a StepProvider's own, or the
// module itself when it is step-capable.
func moduleStep(d core.Descriptor, mod core.Module) (core.StepType, core.Chainable, bool) {
	if d.Status != core.StatusReady || (d.Hidden && !d.HiddenStep) || d.NotAStep || d.ID == "pipelines" {
		return core.StepType{}, nil, false
	}
	if sp, ok := mod.(core.StepProvider); ok {
		return providerStepType(d, sp), sp, true
	}
	ch, _ := mod.(core.Chainable)
	if !stepCapable(d, ch) {
		return core.StepType{}, nil, false
	}
	return moduleStepType(d, ch), ch, true
}

// providerStepType fills a StepProvider's type from the descriptor.
func providerStepType(d core.Descriptor, sp core.StepProvider) core.StepType {
	t := sp.StepType()
	t.ID = d.ID
	if t.Name == "" {
		t.Name = d.Name
	}
	if t.Icon == "" {
		t.Icon = d.Icon
	}
	if t.Category == "" {
		t.Category = d.Category
	}
	if t.Description == "" {
		t.Description = d.Tagline
	}
	if t.DefaultsJSON == "" {
		t.DefaultsJSON = "{}"
		if b, err := json.Marshal(sp.StepDefaults()); err == nil {
			t.DefaultsJSON = string(b)
		}
	}
	t.Auto = true
	if t.Accepts.Extensions == nil {
		t.Accepts.Extensions = []string{}
	}
	return t
}

// stepCapable reports whether a module can be a step at all: ready, listed,
// runs jobs, and either reads something or is Chainable. A Chainable module
// is a step even when its descriptor accepts nothing (Dev Utilities takes no
// drops but reads any file as a step), so a descriptor's Accepts stay about
// drops only.
func stepCapable(d core.Descriptor, ch core.Chainable) bool {
	if d.Status != core.StatusReady || (d.Hidden && !d.HiddenStep) || d.JobLess || d.NotAStep || d.ID == "pipelines" {
		return false
	}
	return ch != nil || d.Accepts.URLs || d.Accepts.Any || len(d.Accepts.Extensions) > 0
}

func moduleStepType(d core.Descriptor, ch core.Chainable) core.StepType {
	t := core.StepType{
		ID: d.ID, ModuleID: d.ID, Name: d.Name, Icon: d.Icon, Category: d.Category,
		Description: d.Tagline, Auto: ch != nil, Manual: true, Accepts: d.Accepts,
		DefaultsJSON: "{}",
	}
	if ch != nil {
		if b, err := json.Marshal(ch.StepDefaults()); err == nil {
			t.DefaultsJSON = string(b)
		}
		if !t.Accepts.URLs && !t.Accepts.Any && len(t.Accepts.Extensions) == 0 {
			if info, err := ch.DescribeStep(json.RawMessage(t.DefaultsJSON)); err == nil {
				t.Accepts = info.Accepts
			}
		}
	}
	if t.Accepts.Extensions == nil {
		t.Accepts.Extensions = []string{}
	}
	return t
}

// Catalog lists every step type: built-ins first (in registration order),
// then modules by descriptor order. Aliases are not listed.
func (r *Runner) Catalog() []core.StepType {
	r.mu.Lock()
	out := make([]core.StepType, 0, len(r.builtins)+32)
	for _, b := range r.builtins {
		out = append(out, b.t)
	}
	r.mu.Unlock()
	ds := r.cfg.Reg.ListAll()
	sort.SliceStable(ds, func(i, j int) bool { return ds[i].Order < ds[j].Order })
	for _, d := range ds {
		mod, _ := r.cfg.Reg.Get(d.ID)
		if t, _, ok := moduleStep(d, mod); ok {
			out = append(out, t)
		}
	}
	return out
}
