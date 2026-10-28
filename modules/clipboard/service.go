package clipboard

import (
	"context"

	"toolbox/core"
)

// Service is the bound Clipboard History service (SPEC.md §4.2). It is a thin
// wrapper over History so that History's lifecycle methods aren't bound.
type Service struct{ h *History }

// NewService builds the service.
func NewService(h *History) *Service { return &Service{h: h} }

// List pages through the history: pinned first, then most recently used.
func (s *Service) List(q core.ClipQuery) (core.ClipPage, error) {
	return s.h.List(context.Background(), q)
}

// Copy writes an item back to the system clipboard and bumps its
// last-used time. The recorder ignores the resulting change.
func (s *Service) Copy(id string) error { return s.h.Copy(context.Background(), id) }

// Pin pins or unpins an item. Pinned items are never pruned.
func (s *Service) Pin(id string, pinned bool) (core.ClipItem, error) {
	return s.h.Pin(context.Background(), id, pinned)
}

// Delete removes items (and their image files).
func (s *Service) Delete(ids []string) error { return s.h.Delete(context.Background(), ids) }

// Clear removes every item (optionally keeping pinned ones) and returns how
// many were removed.
func (s *Service) Clear(keepPinned bool) (int, error) {
	return s.h.Clear(context.Background(), keepPinned)
}

// State reports whether the recorder is running.
func (s *Service) State() core.ClipboardState { return s.h.State() }

// Pause stops recording until Resume or the next app start.
func (s *Service) Pause() error { return s.h.Pause() }

// Resume restarts recording after Pause.
func (s *Service) Resume() error { return s.h.Resume() }

// ImageDataURL returns an image item as "data:image/png;base64,…".
func (s *Service) ImageDataURL(id string) (string, error) {
	return s.h.ImageDataURL(context.Background(), id)
}

// OpenPopup toggles the clipboard popup (same as the hotkey).
func (s *Service) OpenPopup() error { return s.h.OpenPopup() }
