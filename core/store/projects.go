package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"toolbox/core"
)

// Creator-tool projects (SPEC.md Part B §B4), backed by migration 0006.

var _ core.ProjectStore = (*DB)(nil)

const projectCols = `id, kind, name, data, created_at, updated_at`

func scanProject(sc interface{ Scan(...any) error }) (core.StoredProject, error) {
	var p core.StoredProject
	var kind string
	err := sc.Scan(&p.ID, &kind, &p.Name, &p.Data, &p.CreatedAt, &p.UpdatedAt)
	p.Kind = core.ProjectKind(kind)
	return p, err
}

// ListProjects implements core.ProjectStore.
func (d *DB) ListProjects(ctx context.Context, kind core.ProjectKind) ([]core.StoredProject, error) {
	rows, err := d.ro.QueryContext(ctx, `SELECT `+projectCols+` FROM projects WHERE kind = ? ORDER BY updated_at DESC, id DESC`, string(kind))
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	out := []core.StoredProject{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	return out, nil
}

// GetProject implements core.ProjectStore.
func (d *DB) GetProject(ctx context.Context, id string) (core.StoredProject, error) {
	p, err := scanProject(d.ro.QueryRowContext(ctx, `SELECT `+projectCols+` FROM projects WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return core.StoredProject{}, core.Errorf(core.CodeNotFound, "Project not found")
	}
	if err != nil {
		return core.StoredProject{}, fmt.Errorf("get project %s: %w", id, err)
	}
	return p, nil
}

// PutProject implements core.ProjectStore.
func (d *DB) PutProject(ctx context.Context, p core.StoredProject) error {
	if len(p.Data) > core.MaxProjectBytes {
		return core.ValidationError("This project is too large", nil)
	}
	_, err := d.sql.ExecContext(ctx, `INSERT INTO projects (`+projectCols+`) VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`,
		p.ID, string(p.Kind), p.Name, p.Data, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return fmt.Errorf("save project %s: %w", p.ID, err)
	}
	return nil
}

// DeleteProject implements core.ProjectStore.
func (d *DB) DeleteProject(ctx context.Context, id string) error {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete project %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return core.Errorf(core.CodeNotFound, "Project not found")
	}
	return nil
}
