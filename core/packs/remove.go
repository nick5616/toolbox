package packs

import (
	"context"
	"slices"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// packInstalled reports whether every component of the pack is present.
func packInstalled(p PackSpec, st map[string]core.PackComponentState) bool {
	for _, id := range p.Components {
		if !present(st[id]) {
			return false
		}
	}
	return true
}

// removalPlan says which components Remove(id) deletes, what it keeps
// because another installed pack uses it, and the disk space freed. System
// copies are never part of it.
func (s *Service) removalPlan(id string) (remove []ComponentSpec, kept []core.PackKept, freed int64, ok bool) {
	p, found := packByID(id)
	if !found {
		return nil, nil, 0, false
	}
	st := s.states()
	for _, cid := range p.Components {
		c, _ := componentByID(cid)
		if v := st[cid]; v != core.ComponentInstalled && v != core.ComponentOutdated {
			continue // missing, unsupported or a system copy
		}
		var usedBy []string
		for _, other := range Catalog() {
			if other.ID != p.ID && slices.Contains(other.Components, cid) && packInstalled(other, st) {
				usedBy = append(usedBy, other.Name)
			}
		}
		if len(usedBy) > 0 {
			kept = append(kept, core.PackKept{Component: c.Name, UsedBy: usedBy})
			continue
		}
		remove = append(remove, c)
		if sz, ok := s.size(c); ok {
			freed += sz.Disk
		}
	}
	return remove, kept, freed, true
}

// RemovePreview says what Remove(id) would free and keep.
func (s *Service) RemovePreview(id string) core.PackRemovePreview {
	_, kept, freed, _ := s.removalPlan(id)
	if kept == nil {
		kept = []core.PackKept{}
	}
	return core.PackRemovePreview{FreedBytes: freed, Kept: kept}
}

// Remove deletes the pack's components that no other installed pack uses.
// System copies are never touched.
func (s *Service) Remove(id string) error {
	p, found := packByID(id)
	if !found {
		return core.Errorf(core.CodeNotFound, "Unknown tool pack %q", id)
	}
	if s.cfg.Jobs != nil {
		busy := []string{InstallModuleID, MoveModuleID}
		for _, u := range p.Unlocks {
			busy = append(busy, u.Module)
		}
		if s.cfg.Jobs.HasActive(busy...) {
			return core.Errorf(core.CodeConflict, "Wait for running jobs to finish")
		}
	}
	remove, _, _, _ := s.removalPlan(id)
	defer s.notify()
	for _, c := range remove {
		if err := s.removeComponent(c); err != nil {
			return componentError(c, err)
		}
	}
	return nil
}

func (s *Service) removeComponent(c ComponentSpec) error {
	switch c.Kind {
	case core.ComponentModel:
		if mp := s.provider(c.Module); mp != nil {
			return mp.RemoveModel(c.Preset)
		}
		return nil
	case core.ComponentDep:
		if c.DepID == sidecar.DepID {
			if s.cfg.StopEngines != nil {
				s.cfg.StopEngines()
			}
			if err := sidecar.Remove(s.cfg.Paths, nil); err != nil {
				return err
			}
			if s.cfg.Deps != nil {
				s.cfg.Deps.Detect(context.Background())
			}
			return nil
		}
		if s.cfg.Deps == nil {
			return core.Errorf(core.CodeInternal, "Can't remove %s here", c.Name)
		}
		return s.cfg.Deps.RemoveManaged(c.DepID)
	}
	return nil
}
