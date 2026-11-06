package store

import (
	"context"

	"toolbox/core"
)

// Output lineage (Phase 19, SPEC.md §3.3; table output_inputs, migration
// 0009). CONTRACT STUB (Wave 0): L1 implements these with tests.

var _ core.LineageStore = (*DB)(nil)

// AddOutputInputs implements core.LineageStore.
func (d *DB) AddOutputInputs(ctx context.Context, outputID string, inputs []string) error {
	return nil
}

// OutputInputs implements core.LineageStore.
func (d *DB) OutputInputs(ctx context.Context, outputID string) ([]string, error) {
	return []string{}, nil
}

// OutputsFromInput implements core.LineageStore.
func (d *DB) OutputsFromInput(ctx context.Context, path string) ([]core.Output, error) {
	return []core.Output{}, nil
}

// BackfillLineage implements core.LineageStore.
func (d *DB) BackfillLineage(ctx context.Context) (int, error) {
	return 0, nil
}
