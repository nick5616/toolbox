package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"toolbox/core"
)

// Pipeline persistence (SPEC.md §9.1), backed by migration 0005.

var _ core.PipelineStore = (*DB)(nil)

const activeRunStatuses = `('running','waiting')`

// ListPipelines implements core.PipelineStore (oldest first).
func (d *DB) ListPipelines(ctx context.Context) ([]core.Pipeline, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, definition FROM pipelines ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list pipelines: %w", err)
	}
	defer rows.Close()
	out := []core.Pipeline{}
	for rows.Next() {
		var id, def string
		if err := rows.Scan(&id, &def); err != nil {
			return nil, fmt.Errorf("scan pipeline: %w", err)
		}
		var p core.Pipeline
		if err := json.Unmarshal([]byte(def), &p); err != nil {
			return nil, fmt.Errorf("decode pipeline %s: %w", id, err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list pipelines: %w", err)
	}
	return out, nil
}

// PutPipeline implements core.PipelineStore.
func (d *DB) PutPipeline(ctx context.Context, p core.Pipeline) error {
	def, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("encode pipeline: %w", err)
	}
	_, err = d.sql.ExecContext(ctx, `INSERT INTO pipelines (id, name, definition, created_at, updated_at) VALUES (?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at`,
		p.ID, p.Name, string(def), p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return fmt.Errorf("save pipeline %s: %w", p.ID, err)
	}
	return nil
}

// DeletePipeline implements core.PipelineStore.
func (d *DB) DeletePipeline(ctx context.Context, id string) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete pipeline: %w", err)
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM pipelines WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete pipeline %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return core.Errorf(core.CodeNotFound, "Pipeline not found")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM pipeline_watch_seen WHERE pipeline_id = ?`, id); err != nil {
		return fmt.Errorf("delete watch state of %s: %w", id, err)
	}
	return tx.Commit()
}

// PutRun implements core.PipelineStore.
func (d *DB) PutRun(ctx context.Context, run core.PipelineRun, stateJSON string) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO pipeline_runs (id, pipeline_id, status, state, created_at, finished_at) VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET status = excluded.status, state = excluded.state, finished_at = excluded.finished_at`,
		run.ID, run.PipelineID, string(run.Status), stateJSON, run.CreatedAt, run.FinishedAt)
	if err != nil {
		return fmt.Errorf("save run %s: %w", run.ID, err)
	}
	return nil
}

// GetRun implements core.PipelineStore.
func (d *DB) GetRun(ctx context.Context, id string) (string, error) {
	var state string
	err := d.sql.QueryRowContext(ctx, `SELECT state FROM pipeline_runs WHERE id = ?`, id).Scan(&state)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", core.Errorf(core.CodeNotFound, "Run not found")
		}
		return "", fmt.Errorf("get run %s: %w", id, err)
	}
	return state, nil
}

// ListRuns implements core.PipelineStore.
func (d *DB) ListRuns(ctx context.Context, f core.RunFilter) ([]string, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	var where []string
	var args []any
	if f.PipelineID != "" {
		where = append(where, "pipeline_id = ?")
		args = append(args, f.PipelineID)
	}
	if f.ActiveOnly {
		where = append(where, "status IN "+activeRunStatuses)
	}
	q := `SELECT state FROM pipeline_runs`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, fmt.Errorf("scan run: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list runs: %w", err)
	}
	return out, nil
}

// DeleteRuns implements core.PipelineStore.
func (d *DB) DeleteRuns(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i], args[i] = "?", id
	}
	if _, err := d.sql.ExecContext(ctx, `DELETE FROM pipeline_runs WHERE id IN (`+strings.Join(ph, ",")+`)`, args...); err != nil {
		return fmt.Errorf("delete runs: %w", err)
	}
	return nil
}

// PruneRuns implements core.PipelineStore.
func (d *DB) PruneRuns(ctx context.Context, keepFinished int) ([]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id FROM pipeline_runs WHERE status NOT IN `+activeRunStatuses+`
		ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`, max(keepFinished, 0))
	if err != nil {
		return nil, fmt.Errorf("prune runs: %w", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan run: %w", err)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, fmt.Errorf("prune runs: %w", err)
	}
	if err := d.DeleteRuns(ctx, ids); err != nil {
		return nil, err
	}
	return ids, nil
}

// SeenFiles implements core.PipelineStore.
func (d *DB) SeenFiles(ctx context.Context, pipelineID string) (map[string]core.SeenFile, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT path, size, mtime FROM pipeline_watch_seen WHERE pipeline_id = ?`, pipelineID)
	if err != nil {
		return nil, fmt.Errorf("list seen files: %w", err)
	}
	defer rows.Close()
	out := map[string]core.SeenFile{}
	for rows.Next() {
		var f core.SeenFile
		if err := rows.Scan(&f.Path, &f.Size, &f.MTime); err != nil {
			return nil, fmt.Errorf("scan seen file: %w", err)
		}
		out[f.Path] = f
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list seen files: %w", err)
	}
	return out, nil
}

// MarkSeen implements core.PipelineStore.
func (d *DB) MarkSeen(ctx context.Context, pipelineID string, files []core.SeenFile) error {
	if len(files) == 0 {
		return nil
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("mark seen: %w", err)
	}
	defer tx.Rollback()
	for _, f := range files {
		if _, err := tx.ExecContext(ctx, `INSERT INTO pipeline_watch_seen (pipeline_id, path, size, mtime) VALUES (?,?,?,?)
			ON CONFLICT(pipeline_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime`,
			pipelineID, f.Path, f.Size, f.MTime); err != nil {
			return fmt.Errorf("mark seen %s: %w", f.Path, err)
		}
	}
	return tx.Commit()
}

// ForgetSeen implements core.PipelineStore.
func (d *DB) ForgetSeen(ctx context.Context, pipelineID string, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("forget seen: %w", err)
	}
	defer tx.Rollback()
	for _, p := range paths {
		if _, err := tx.ExecContext(ctx, `DELETE FROM pipeline_watch_seen WHERE pipeline_id = ? AND path = ?`, pipelineID, p); err != nil {
			return fmt.Errorf("forget seen %s: %w", p, err)
		}
	}
	return tx.Commit()
}
