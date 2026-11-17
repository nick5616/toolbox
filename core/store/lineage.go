package store

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Output lineage (Phase 19, SPEC.md §3.3; table output_inputs, migration
// 0009).

var _ core.LineageStore = (*DB)(nil)

// AddOutputInputs implements core.LineageStore.
func (d *DB) AddOutputInputs(ctx context.Context, outputID string, inputs []string) error {
	if len(inputs) == 0 {
		return nil
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("add output inputs: %w", err)
	}
	defer tx.Rollback()
	for _, in := range inputs {
		if in == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO output_inputs (output_id, input_path) VALUES (?, ?)`, outputID, in); err != nil {
			return fmt.Errorf("add output input: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("add output inputs: %w", err)
	}
	return nil
}

// OutputInputs implements core.LineageStore.
func (d *DB) OutputInputs(ctx context.Context, outputID string) ([]string, error) {
	rows, err := d.ro.QueryContext(ctx, `SELECT input_path FROM output_inputs WHERE output_id = ? ORDER BY input_path`, outputID)
	if err != nil {
		return nil, fmt.Errorf("output inputs: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, fmt.Errorf("scan output input: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// OutputsFromInput implements core.LineageStore.
func (d *DB) OutputsFromInput(ctx context.Context, path string) ([]core.Output, error) {
	return d.queryOutputs(ctx, `SELECT `+outputCols+` FROM outputs
		WHERE id IN (SELECT output_id FROM output_inputs WHERE input_path = ?)
		ORDER BY created_at DESC, id DESC`, path)
}

// lineageDoneKey is the settings row set after the first full backfill pass.
const lineageDoneKey = "meta.lineageBackfilled"

// BackfillLineage implements core.LineageStore.
func (d *DB) BackfillLineage(ctx context.Context) (int, error) {
	// One full pass is enough: outputs it couldn't link stay unlinkable, and
	// new outputs get their lineage when they're registered.
	if _, done, err := d.GetSetting(ctx, lineageDoneKey); err == nil && done {
		return 0, nil
	}
	rows, err := d.ro.QueryContext(ctx, `SELECT o.id, o.path, j.inputs FROM outputs o
		JOIN jobs j ON j.id = o.job_id
		WHERE NOT EXISTS (SELECT 1 FROM output_inputs i WHERE i.output_id = o.id)`)
	if err != nil {
		return 0, fmt.Errorf("backfill lineage: %w", err)
	}
	type pending struct {
		id     string
		inputs []string
	}
	var todo []pending
	for rows.Next() {
		var id, path, raw string
		if err := rows.Scan(&id, &path, &raw); err != nil {
			rows.Close()
			return 0, fmt.Errorf("backfill lineage: %w", err)
		}
		var ins []string
		if json.Unmarshal([]byte(raw), &ins) != nil {
			continue
		}
		if in := core.LineageInputs(path, nil, ins); len(in) > 0 {
			todo = append(todo, pending{id, in})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, fmt.Errorf("backfill lineage: %w", err)
	}
	added := 0
	for _, p := range todo {
		if err := ctx.Err(); err != nil {
			return added, err
		}
		if err := d.AddOutputInputs(ctx, p.id, p.inputs); err != nil {
			return added, err
		}
		added += len(p.inputs)
	}
	if err := d.SetSetting(ctx, lineageDoneKey, "1"); err != nil {
		return added, err
	}
	return added, nil
}
