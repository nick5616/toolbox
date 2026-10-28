package store

import (
	"context"

	"toolbox/core"
)

// Clipboard history (SPEC.md §3.3). FOUNDATION STUB: WP-CB1 implements these.

var _ core.ClipStore = (*DB)(nil)

var errClipTODO = core.Errorf(core.CodeInternal, "Clipboard history storage isn't implemented yet")

func (d *DB) UpsertClip(ctx context.Context, c core.ClipItem) (core.ClipItem, bool, error) {
	return core.ClipItem{}, false, errClipTODO
}

func (d *DB) ListClips(ctx context.Context, q core.ClipQuery) (core.ClipPage, error) {
	return core.ClipPage{Items: []core.ClipItem{}}, nil
}

func (d *DB) GetClip(ctx context.Context, id string) (core.ClipItem, error) {
	return core.ClipItem{}, errClipTODO
}

func (d *DB) TouchClip(ctx context.Context, id string, at int64) (core.ClipItem, error) {
	return core.ClipItem{}, errClipTODO
}

func (d *DB) SetPinned(ctx context.Context, id string, pinned bool) (core.ClipItem, error) {
	return core.ClipItem{}, errClipTODO
}

func (d *DB) DeleteClips(ctx context.Context, ids []string) ([]core.ClipItem, error) {
	return nil, errClipTODO
}

func (d *DB) ClearClips(ctx context.Context, keepPinned bool) ([]core.ClipItem, error) {
	return nil, errClipTODO
}

func (d *DB) PruneClips(ctx context.Context, olderThanMs int64, maxItems int) ([]core.ClipItem, error) {
	return nil, nil
}
