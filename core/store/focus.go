package store

import (
	"context"

	"toolbox/core"
	"toolbox/core/focus"
)

// Focus Lock persistence (SPEC.md §2.2, migration 0008). Wave 0 stubs;
// WP-F1 implements them. Settings live in the settings table under "focus".

// FocusStore returns the focus.Store backed by this database.
func (d *DB) FocusStore() focus.Store { return &focusStore{d: d} }

type focusStore struct{ d *DB }

var _ focus.Store = (*focusStore)(nil)

func focusTODO() error { return core.NotImplemented("Focus storage") }

func (f *focusStore) Profiles(ctx context.Context) ([]focus.Profile, error) {
	return []focus.Profile{}, nil
}
func (f *focusStore) PutProfile(ctx context.Context, p focus.Profile) error { return focusTODO() }
func (f *focusStore) DeleteProfile(ctx context.Context, id string) error    { return focusTODO() }
func (f *focusStore) ActiveSession(ctx context.Context) (*focus.Session, error) {
	return nil, nil
}
func (f *focusStore) PutSession(ctx context.Context, s focus.Session) error { return focusTODO() }
func (f *focusStore) RecentSessions(ctx context.Context, limit int) ([]focus.Session, error) {
	return []focus.Session{}, nil
}
func (f *focusStore) AddEvents(ctx context.Context, evs []focus.BlockEvent) error {
	return focusTODO()
}
func (f *focusStore) Events(ctx context.Context, sessionID string, limit int) ([]focus.BlockEvent, error) {
	return []focus.BlockEvent{}, nil
}
func (f *focusStore) LearnEntries(ctx context.Context, since int64) ([]focus.LearnEntry, error) {
	return []focus.LearnEntry{}, nil
}
func (f *focusStore) ClearLearn(ctx context.Context, path string) error { return focusTODO() }
func (f *focusStore) PruneEvents(ctx context.Context, before int64, keep int) error {
	return nil
}
func (f *focusStore) GetSettings(ctx context.Context) (focus.Settings, bool, error) {
	return focus.Settings{}, false, nil
}
func (f *focusStore) PutSettings(ctx context.Context, s focus.Settings) error { return focusTODO() }
