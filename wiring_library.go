package main

import (
	"toolbox/core"
	"toolbox/modules/eraser"
)

// eraserSavedMasks adapts Object Eraser's saved masks for the Library's
// "Other places" (Phase 19, SPEC.md §3.1).
func eraserSavedMasks(m *eraser.Module) func() ([]core.LibrarySavedMask, error) {
	return func() ([]core.LibrarySavedMask, error) {
		list, err := m.SavedMasks()
		if err != nil {
			return nil, err
		}
		out := make([]core.LibrarySavedMask, 0, len(list))
		for _, s := range list {
			out = append(out, core.LibrarySavedMask{ID: s.ID, Name: s.Name, Width: s.Width, Height: s.Height, CreatedAt: s.CreatedAt})
		}
		return out, nil
	}
}
