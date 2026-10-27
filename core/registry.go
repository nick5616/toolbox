package core

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
)

// Registry holds every module and placeholder. Safe for concurrent use.
type Registry struct {
	mu          sync.RWMutex
	modules     map[string]Module
	descriptors map[string]Descriptor
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{modules: map[string]Module{}, descriptors: map[string]Descriptor{}}
}

// Register adds a runnable module.
func (r *Registry) Register(m Module) error {
	d := m.Descriptor()
	if err := r.add(d); err != nil {
		return err
	}
	r.mu.Lock()
	r.modules[d.ID] = m
	r.mu.Unlock()
	return nil
}

// RegisterPlaceholder adds a "coming soon" module that can't run.
func (r *Registry) RegisterPlaceholder(d Descriptor) error {
	d.Status = StatusComingSoon
	return r.add(d)
}

func (r *Registry) add(d Descriptor) error {
	if d.ID == "" {
		return fmt.Errorf("register module: empty ID")
	}
	exts := make([]string, len(d.Accepts.Extensions))
	for i, e := range d.Accepts.Extensions {
		exts[i] = strings.ToLower(e)
	}
	d.Accepts.Extensions = exts
	if d.Requires == nil {
		d.Requires = []string{}
	}
	if d.Recommends == nil {
		d.Recommends = []string{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.descriptors[d.ID]; dup {
		return fmt.Errorf("register module %q: duplicate ID", d.ID)
	}
	r.descriptors[d.ID] = d
	return nil
}

// Get returns a runnable module. Placeholders return false.
func (r *Registry) Get(id string) (Module, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.modules[id]
	return m, ok
}

// Descriptor returns any registered descriptor, including hidden ones.
func (r *Registry) Descriptor(id string) (Descriptor, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.descriptors[id]
	return d, ok
}

// List returns non-hidden descriptors sorted by Order, then Name.
func (r *Registry) List() []Descriptor {
	r.mu.RLock()
	out := make([]Descriptor, 0, len(r.descriptors))
	for _, d := range r.descriptors {
		if !d.Hidden {
			out = append(out, d)
		}
	}
	r.mu.RUnlock()
	sortDescriptors(out)
	return out
}

func sortDescriptors(ds []Descriptor) {
	sort.SliceStable(ds, func(i, j int) bool {
		if ds[i].Order != ds[j].Order {
			return ds[i].Order < ds[j].Order
		}
		return ds[i].Name < ds[j].Name
	})
}

// Match reports which non-hidden modules accept the given file paths, by
// extension (case-insensitive). Directories are always unmatched. Matches are
// ordered ready-first, then by Order and Name.
func (r *Registry) Match(paths []string) MatchResult {
	list := r.List()
	byModule := map[string][]string{}
	var unmatched []string
	for _, p := range paths {
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			unmatched = append(unmatched, p)
			continue
		}
		ext := strings.ToLower(filepath.Ext(p))
		hit := false
		if ext != "" {
			for _, d := range list {
				if slices.Contains(d.Accepts.Extensions, ext) {
					byModule[d.ID] = append(byModule[d.ID], p)
					hit = true
				}
			}
		}
		if !hit {
			unmatched = append(unmatched, p)
		}
	}
	res := MatchResult{Matches: []ModuleMatch{}, Unmatched: unmatched}
	if res.Unmatched == nil {
		res.Unmatched = []string{}
	}
	for _, d := range list {
		if ps, ok := byModule[d.ID]; ok {
			res.Matches = append(res.Matches, ModuleMatch{Module: d, Paths: ps})
		}
	}
	sort.SliceStable(res.Matches, func(i, j int) bool {
		ri := res.Matches[i].Module.Status == StatusReady
		rj := res.Matches[j].Module.Status == StatusReady
		return ri && !rj
	})
	return res
}

// RequiringDep returns IDs of ready modules (hidden included) that require depID.
func (r *Registry) RequiringDep(depID string) []string {
	return r.withDep(depID, func(d Descriptor) []string { return d.Requires })
}

// RecommendingDep returns IDs of ready modules that recommend depID.
func (r *Registry) RecommendingDep(depID string) []string {
	return r.withDep(depID, func(d Descriptor) []string { return d.Recommends })
}

func (r *Registry) withDep(depID string, field func(Descriptor) []string) []string {
	r.mu.RLock()
	var ds []Descriptor
	for _, d := range r.descriptors {
		if d.Status == StatusReady && slices.Contains(field(d), depID) {
			ds = append(ds, d)
		}
	}
	r.mu.RUnlock()
	sortDescriptors(ds)
	ids := make([]string, len(ds))
	for i, d := range ds {
		ids[i] = d.ID
	}
	return ids
}
