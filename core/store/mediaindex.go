package store

import (
	"context"

	"toolbox/core/mediaindex"
)

// Smart search's tables (migration 0011, SPEC.md §2). CONTRACT STUB (Wave 0):
// S2 owns this file and mediaindex.Store and grows them together.

// MediaIndex returns the index's store.
func (d *DB) MediaIndex() mediaindex.Store { return &mediaStore{d: d} }

type mediaStore struct{ d *DB }

func (m *mediaStore) GetSetting(ctx context.Context, key string) (string, bool, error) {
	return m.d.GetSetting(ctx, key)
}

func (m *mediaStore) SetSetting(ctx context.Context, key, value string) error {
	return m.d.SetSetting(ctx, key, value)
}
