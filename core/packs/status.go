package packs

import (
	"context"
	"encoding/json"
	"os"
	"slices"

	"toolbox/core"
)

func packByID(id string) (PackSpec, bool) {
	for _, p := range Catalog() {
		if p.ID == id {
			return p, true
		}
	}
	return PackSpec{}, false
}

func componentByID(id string) (ComponentSpec, bool) {
	for _, c := range Components() {
		if c.ID == id {
			return c, true
		}
	}
	return ComponentSpec{}, false
}

// unlockFor finds the pack and unlock entry providing a module.
func unlockFor(moduleID string) (PackSpec, Unlock, bool) {
	for _, p := range Catalog() {
		for _, u := range p.Unlocks {
			if u.Module == moduleID {
				return p, u, true
			}
		}
	}
	return PackSpec{}, Unlock{}, false
}

// packsOf lists the packs containing a component, in catalog order.
func packsOf(componentID string) []string {
	out := []string{}
	for _, p := range Catalog() {
		if slices.Contains(p.Components, componentID) {
			out = append(out, p.ID)
		}
	}
	return out
}

// provider finds the ModelProvider of a model component's module. Providers
// that take a models folder (SetModelsDir) are given the tools folder's.
func (s *Service) provider(module string) core.ModelProvider {
	if s.cfg.Reg == nil {
		return nil
	}
	m, ok := s.cfg.Reg.Get(module)
	if !ok {
		return nil
	}
	s.mu.Lock()
	if !s.injected[module] {
		s.injected[module] = true
		if ms, ok := m.(interface{ SetModelsDir(string) }); ok {
			ms.SetModelsDir(s.cfg.Paths.ModelsDir)
		}
	}
	s.mu.Unlock()
	mp, _ := m.(core.ModelProvider)
	return mp
}

// size returns the component's size on this platform.
func (s *Service) size(c ComponentSpec) (Size, bool) {
	if s.key == "" {
		return Size{}, false
	}
	sz, ok := c.Sizes[s.key]
	return sz, ok
}

func (s *Service) depStatuses() map[string]core.DepStatus {
	out := map[string]core.DepStatus{}
	if s.cfg.Deps == nil {
		return out
	}
	for _, d := range s.cfg.Deps.List() {
		out[d.ID] = d
	}
	return out
}

// componentState derives one component's state from dep detection and model
// file checks.
func (s *Service) componentState(c ComponentSpec, ds map[string]core.DepStatus) core.PackComponentState {
	if _, ok := s.size(c); !ok {
		return core.ComponentUnsupported
	}
	switch c.Kind {
	case core.ComponentDep:
		d, ok := ds[c.DepID]
		if !ok {
			return core.ComponentMissing
		}
		switch d.State {
		case core.DepOK:
			if d.Source == core.SourcePath || d.Source == core.SourceKnownDir {
				return core.ComponentSystem
			}
			return core.ComponentInstalled
		case core.DepOutdated:
			return core.ComponentOutdated
		}
		return core.ComponentMissing
	case core.ComponentModel:
		if p := s.provider(c.Module); p != nil && p.ModelPresent(c.Preset) {
			return core.ComponentInstalled
		}
	}
	return core.ComponentMissing
}

func present(st core.PackComponentState) bool {
	return st == core.ComponentInstalled || st == core.ComponentSystem || st == core.ComponentOutdated
}

// states computes every component's state once.
func (s *Service) states() map[string]core.PackComponentState {
	ds := s.depStatuses()
	out := map[string]core.PackComponentState{}
	for _, c := range Components() {
		out[c.ID] = s.componentState(c, ds)
	}
	return out
}

// unsupportedReason is non-empty when a pack can't be installed here.
func (s *Service) unsupportedReason(packID string) string {
	p, ok := packByID(packID)
	if !ok {
		return ""
	}
	for _, id := range p.Components {
		c, _ := componentByID(id)
		if _, ok := s.size(c); !ok {
			return c.Name + " isn't available for this computer yet"
		}
	}
	return ""
}

// missingAmong returns the IDs of the components (of ids) that are missing or
// outdated, in the given order.
func (s *Service) missingAmong(ids []string) []string {
	st := s.states()
	var out []string
	for _, id := range ids {
		if v := st[id]; v == core.ComponentMissing || v == core.ComponentOutdated {
			out = append(out, id)
		}
	}
	return out
}

// activeInstalls maps pack ID → ID of its queued or running install job.
func (s *Service) activeInstalls() map[string]string {
	out := map[string]string{}
	if s.cfg.Jobs == nil {
		return out
	}
	js, err := s.cfg.Jobs.List(context.Background(), core.JobFilter{
		ModuleID: InstallModuleID, Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 500,
	})
	if err != nil {
		return out
	}
	// Newest first; keep the oldest (the one that runs first) per pack.
	for i := len(js) - 1; i >= 0; i-- {
		var o InstallOptions
		if json.Unmarshal([]byte(js[i].OptionsJSON), &o) == nil && o.Pack != "" {
			if _, dup := out[o.Pack]; !dup {
				out[o.Pack] = js[i].ID
			}
		}
	}
	return out
}

// List returns every pack with its components and state.
func (s *Service) List() []core.PackStatus {
	st := s.states()
	active := s.activeInstalls()
	catalog := Catalog()
	out := make([]core.PackStatus, 0, len(catalog))
	for _, p := range catalog {
		ps := core.PackStatus{
			ID: p.ID, Name: p.Name, Icon: p.Icon, Description: p.Description,
			Components: []core.PackComponentStatus{}, Unlocks: []core.PackUnlock{},
		}
		var nPresent, nOutdated int
		for _, cid := range p.Components {
			c, _ := componentByID(cid)
			state := st[cid]
			cs := core.PackComponentStatus{
				ID: c.ID, Name: c.Name, Href: c.Href, License: c.License, Kind: c.Kind,
				State: state, Packs: packsOf(c.ID),
			}
			// Present components cost nothing; an outdated one is re-downloaded.
			if sz, ok := s.size(c); ok && (!present(state) || state == core.ComponentOutdated) {
				cs.DownloadBytes, cs.DiskBytes = sz.Download, sz.Disk
			}
			if state == core.ComponentUnsupported && ps.UnsupportedReason == "" {
				ps.UnsupportedReason = c.Name + " isn't available for this computer yet"
			}
			if present(state) {
				nPresent++
			}
			if state == core.ComponentOutdated {
				nOutdated++
			}
			ps.Components = append(ps.Components, cs)
		}
		for _, u := range p.Unlocks {
			if s.cfg.Reg == nil {
				break
			}
			d, ok := s.cfg.Reg.Descriptor(u.Module)
			if !ok || d.Status == core.StatusComingSoon {
				continue
			}
			ps.Unlocks = append(ps.Unlocks, core.PackUnlock{ModuleID: u.Module, Name: d.Name, Icon: d.Icon})
		}
		jobID, installing := active[p.ID]
		switch {
		case ps.UnsupportedReason != "":
			ps.State = core.PackUnsupported
		case installing:
			ps.State, ps.JobID = core.PackInstalling, jobID
		case nPresent == len(p.Components) && nOutdated > 0:
			ps.State = core.PackOutdated
		case nPresent == len(p.Components):
			ps.State = core.PackInstalled
		case nPresent == 0:
			ps.State = core.PackMissing
		default:
			ps.State = core.PackPartial
		}
		out = append(out, ps)
	}
	return out
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
