package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"toolbox/core"
)

const outputCols = `id, job_id, module_id, path, name, kind, size_bytes, created_at`

// queryOutputs runs an outputs SELECT (using outputCols), then fills Tags and
// Missing. Rows are fully read before the tag query (single connection).
func (d *DB) queryOutputs(ctx context.Context, q string, args ...any) ([]core.Output, error) {
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query outputs: %w", err)
	}
	outs := []core.Output{}
	for rows.Next() {
		var o core.Output
		var jobID sql.NullString
		var kind string
		if err := rows.Scan(&o.ID, &jobID, &o.ModuleID, &o.Path, &o.Name, &kind, &o.SizeBytes, &o.CreatedAt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan output: %w", err)
		}
		o.JobID = jobID.String
		o.Kind = core.OutputKind(kind)
		o.Tags = []string{}
		outs = append(outs, o)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, fmt.Errorf("query outputs: %w", err)
	}
	if len(outs) == 0 {
		return outs, nil
	}
	ph := make([]string, len(outs))
	ids := make([]any, len(outs))
	idx := make(map[string]int, len(outs))
	for i := range outs {
		ph[i] = "?"
		ids[i] = outs[i].ID
		idx[outs[i].ID] = i
		if _, err := os.Stat(outs[i].Path); err != nil {
			outs[i].Missing = true
		}
	}
	trows, err := d.sql.QueryContext(ctx, `SELECT output_id, tag FROM output_tags WHERE output_id IN (`+strings.Join(ph, ",")+`) ORDER BY tag`, ids...)
	if err != nil {
		return nil, fmt.Errorf("query output tags: %w", err)
	}
	defer trows.Close()
	for trows.Next() {
		var id, tag string
		if err := trows.Scan(&id, &tag); err != nil {
			return nil, fmt.Errorf("scan tag: %w", err)
		}
		outs[idx[id]].Tags = append(outs[idx[id]].Tags, tag)
	}
	if err := trows.Err(); err != nil {
		return nil, fmt.Errorf("query output tags: %w", err)
	}
	return outs, nil
}

func (d *DB) UpsertOutput(ctx context.Context, o core.Output) (core.Output, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.Output{}, fmt.Errorf("upsert output: %w", err)
	}
	defer tx.Rollback()

	var jobID any
	if o.JobID != "" {
		jobID = o.JobID
	}
	id := o.ID
	err = tx.QueryRowContext(ctx, `SELECT id FROM outputs WHERE path = ?`, o.Path).Scan(&id)
	switch {
	case err == nil:
		if _, err := tx.ExecContext(ctx, `UPDATE outputs SET job_id=?, module_id=?, size_bytes=?, created_at=? WHERE id=?`,
			jobID, o.ModuleID, o.SizeBytes, o.CreatedAt, id); err != nil {
			return core.Output{}, fmt.Errorf("update output: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM output_tags WHERE output_id = ?`, id); err != nil {
			return core.Output{}, fmt.Errorf("replace tags: %w", err)
		}
	case errors.Is(err, sql.ErrNoRows):
		if id == "" {
			id = core.NewID()
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO outputs (`+outputCols+`) VALUES (?,?,?,?,?,?,?,?)`,
			id, jobID, o.ModuleID, o.Path, o.Name, string(o.Kind), o.SizeBytes, o.CreatedAt); err != nil {
			return core.Output{}, fmt.Errorf("insert output: %w", err)
		}
	default:
		return core.Output{}, fmt.Errorf("upsert output: %w", err)
	}
	for _, t := range o.Tags {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO output_tags (output_id, tag) VALUES (?, ?)`, id, t); err != nil {
			return core.Output{}, fmt.Errorf("insert tag: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return core.Output{}, fmt.Errorf("upsert output: %w", err)
	}
	return d.GetOutput(ctx, id)
}

func (d *DB) GetOutput(ctx context.Context, id string) (core.Output, error) {
	outs, err := d.queryOutputs(ctx, `SELECT `+outputCols+` FROM outputs WHERE id = ?`, id)
	if err != nil {
		return core.Output{}, err
	}
	if len(outs) == 0 {
		return core.Output{}, core.Errorf(core.CodeNotFound, "Output not found")
	}
	return outs[0], nil
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

func encodeCursor(createdAt int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(createdAt, 10) + ":" + id))
}

func decodeCursor(c string) (int64, string, error) {
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return 0, "", err
	}
	ts, id, ok := strings.Cut(string(b), ":")
	if !ok {
		return 0, "", errors.New("malformed cursor")
	}
	n, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return 0, "", err
	}
	return n, id, nil
}

func (d *DB) ListOutputs(ctx context.Context, q core.OutputQuery) (core.OutputPage, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	var where []string
	var args []any
	if q.ModuleID != "" {
		where = append(where, "module_id = ?")
		args = append(args, q.ModuleID)
	}
	if q.Search != "" {
		where = append(where, `name LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(q.Search)+"%")
	}
	if q.Cursor != "" {
		ts, id, err := decodeCursor(q.Cursor)
		if err != nil {
			return core.OutputPage{}, core.Errorf(core.CodeValidation, "Invalid page cursor")
		}
		where = append(where, "(created_at < ? OR (created_at = ? AND id < ?))")
		args = append(args, ts, ts, id)
	}
	sqlq := `SELECT ` + outputCols + ` FROM outputs`
	if len(where) > 0 {
		sqlq += ` WHERE ` + strings.Join(where, " AND ")
	}
	sqlq += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit+1)
	outs, err := d.queryOutputs(ctx, sqlq, args...)
	if err != nil {
		return core.OutputPage{}, err
	}
	page := core.OutputPage{Items: outs}
	if len(outs) > limit {
		page.Items = outs[:limit]
		last := page.Items[limit-1]
		page.NextCursor = encodeCursor(last.CreatedAt, last.ID)
	}
	return page, nil
}

func (d *DB) DeleteOutput(ctx context.Context, id string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM outputs WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete output %s: %w", id, err)
	}
	return nil
}
