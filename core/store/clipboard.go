package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"toolbox/core"
)

// Clipboard history storage (SPEC.md §3.3).

var _ core.ClipStore = (*DB)(nil)

const clipCols = `id, kind, text, preview, image_path, width, height, hash, byte_size, pinned, created_at, last_used_at`

type clipQuerier interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

func scanClip(sc interface{ Scan(...any) error }) (core.ClipItem, error) {
	var c core.ClipItem
	var kind string
	var pinned int
	if err := sc.Scan(&c.ID, &kind, &c.Text, &c.Preview, &c.ImagePath, &c.Width, &c.Height, &c.Hash,
		&c.ByteSize, &pinned, &c.CreatedAt, &c.LastUsedAt); err != nil {
		return core.ClipItem{}, err
	}
	c.Kind = core.ClipKind(kind)
	c.Pinned = pinned != 0
	return c, nil
}

func queryClips(ctx context.Context, q clipQuerier, query string, args ...any) ([]core.ClipItem, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query clips: %w", err)
	}
	defer rows.Close()
	items := []core.ClipItem{}
	for rows.Next() {
		c, err := scanClip(rows)
		if err != nil {
			return nil, fmt.Errorf("scan clip: %w", err)
		}
		items = append(items, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("query clips: %w", err)
	}
	return items, nil
}

func getClip(ctx context.Context, q clipQuerier, id string) (core.ClipItem, error) {
	c, err := scanClip(q.QueryRowContext(ctx, `SELECT `+clipCols+` FROM clip_items WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return core.ClipItem{}, core.Errorf(core.CodeNotFound, "Clipboard item not found")
	}
	if err != nil {
		return core.ClipItem{}, fmt.Errorf("get clip %s: %w", id, err)
	}
	return c, nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (d *DB) UpsertClip(ctx context.Context, c core.ClipItem) (core.ClipItem, bool, error) {
	if c.Hash == "" {
		return core.ClipItem{}, false, core.Errorf(core.CodeInternal, "Clipboard item has no hash")
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ClipItem{}, false, fmt.Errorf("upsert clip: %w", err)
	}
	defer tx.Rollback()

	existing, err := scanClip(tx.QueryRowContext(ctx, `SELECT `+clipCols+` FROM clip_items WHERE hash = ?`, c.Hash))
	switch {
	case err == nil:
		last := c.LastUsedAt
		if last == 0 {
			last = core.NowMillis()
		}
		if _, err := tx.ExecContext(ctx, `UPDATE clip_items SET last_used_at = ? WHERE id = ?`, last, existing.ID); err != nil {
			return core.ClipItem{}, false, fmt.Errorf("bump clip: %w", err)
		}
		existing.LastUsedAt = last
		if err := tx.Commit(); err != nil {
			return core.ClipItem{}, false, fmt.Errorf("upsert clip: %w", err)
		}
		return existing, false, nil
	case errors.Is(err, sql.ErrNoRows):
	default:
		return core.ClipItem{}, false, fmt.Errorf("upsert clip: %w", err)
	}

	if c.ID == "" {
		c.ID = core.NewID()
	}
	if c.CreatedAt == 0 {
		c.CreatedAt = core.NowMillis()
	}
	if c.LastUsedAt == 0 {
		c.LastUsedAt = c.CreatedAt
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO clip_items (`+clipCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		c.ID, string(c.Kind), c.Text, c.Preview, c.ImagePath, c.Width, c.Height, c.Hash,
		c.ByteSize, b2i(c.Pinned), c.CreatedAt, c.LastUsedAt); err != nil {
		return core.ClipItem{}, false, fmt.Errorf("insert clip: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return core.ClipItem{}, false, fmt.Errorf("upsert clip: %w", err)
	}
	return c, true, nil
}

func encodeClipCursor(c core.ClipItem) string {
	s := strconv.Itoa(b2i(c.Pinned)) + ":" + strconv.FormatInt(c.LastUsedAt, 10) + ":" + c.ID
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func decodeClipCursor(cur string) (pinned int, last int64, id string, err error) {
	b, err := base64.RawURLEncoding.DecodeString(cur)
	if err != nil {
		return 0, 0, "", err
	}
	parts := strings.SplitN(string(b), ":", 3)
	if len(parts) != 3 {
		return 0, 0, "", errors.New("malformed cursor")
	}
	if pinned, err = strconv.Atoi(parts[0]); err != nil || (pinned != 0 && pinned != 1) {
		return 0, 0, "", errors.New("malformed cursor")
	}
	if last, err = strconv.ParseInt(parts[1], 10, 64); err != nil {
		return 0, 0, "", err
	}
	return pinned, last, parts[2], nil
}

func (d *DB) ListClips(ctx context.Context, q core.ClipQuery) (core.ClipPage, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	var where []string
	var args []any
	if q.Search != "" {
		where = append(where, `preview LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(q.Search)+"%")
	}
	if q.Kind != "" {
		where = append(where, `kind = ?`)
		args = append(args, string(q.Kind))
	}
	if q.Cursor != "" {
		p, last, id, err := decodeClipCursor(q.Cursor)
		if err != nil {
			return core.ClipPage{}, core.Errorf(core.CodeValidation, "Invalid page cursor")
		}
		where = append(where, `(pinned < ? OR (pinned = ? AND (last_used_at < ? OR (last_used_at = ? AND id < ?))))`)
		args = append(args, p, p, last, last, id)
	}
	query := `SELECT ` + clipCols + ` FROM clip_items`
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, " AND ")
	}
	query += ` ORDER BY pinned DESC, last_used_at DESC, id DESC LIMIT ?`
	args = append(args, limit+1)
	items, err := queryClips(ctx, d.sql, query, args...)
	if err != nil {
		return core.ClipPage{}, err
	}
	page := core.ClipPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextCursor = encodeClipCursor(page.Items[limit-1])
	}
	return page, nil
}

func (d *DB) GetClip(ctx context.Context, id string) (core.ClipItem, error) {
	return getClip(ctx, d.sql, id)
}

func (d *DB) TouchClip(ctx context.Context, id string, at int64) (core.ClipItem, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE clip_items SET last_used_at = ? WHERE id = ?`, at, id)
	if err != nil {
		return core.ClipItem{}, fmt.Errorf("touch clip: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return core.ClipItem{}, core.Errorf(core.CodeNotFound, "Clipboard item not found")
	}
	return getClip(ctx, d.sql, id)
}

func (d *DB) SetPinned(ctx context.Context, id string, pinned bool) (core.ClipItem, error) {
	res, err := d.sql.ExecContext(ctx, `UPDATE clip_items SET pinned = ? WHERE id = ?`, b2i(pinned), id)
	if err != nil {
		return core.ClipItem{}, fmt.Errorf("pin clip: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return core.ClipItem{}, core.Errorf(core.CodeNotFound, "Clipboard item not found")
	}
	return getClip(ctx, d.sql, id)
}

// deleteClipRows deletes the given rows by ID inside tx, in chunks.
func deleteClipRows(ctx context.Context, tx clipQuerier, items []core.ClipItem) error {
	const chunk = 500
	for i := 0; i < len(items); i += chunk {
		end := min(i+chunk, len(items))
		ph := make([]string, 0, chunk)
		args := make([]any, 0, chunk)
		for _, it := range items[i:end] {
			ph = append(ph, "?")
			args = append(args, it.ID)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM clip_items WHERE id IN (`+strings.Join(ph, ",")+`)`, args...); err != nil {
			return fmt.Errorf("delete clips: %w", err)
		}
	}
	return nil
}

func (d *DB) DeleteClips(ctx context.Context, ids []string) ([]core.ClipItem, error) {
	if len(ids) == 0 {
		return []core.ClipItem{}, nil
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("delete clips: %w", err)
	}
	defer tx.Rollback()
	found := []core.ClipItem{}
	const chunk = 500
	for i := 0; i < len(ids); i += chunk {
		end := min(i+chunk, len(ids))
		ph := make([]string, 0, chunk)
		args := make([]any, 0, chunk)
		for _, id := range ids[i:end] {
			ph = append(ph, "?")
			args = append(args, id)
		}
		items, err := queryClips(ctx, tx, `SELECT `+clipCols+` FROM clip_items WHERE id IN (`+strings.Join(ph, ",")+`)`, args...)
		if err != nil {
			return nil, err
		}
		found = append(found, items...)
	}
	if err := deleteClipRows(ctx, tx, found); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("delete clips: %w", err)
	}
	return found, nil
}

func (d *DB) ClearClips(ctx context.Context, keepPinned bool) ([]core.ClipItem, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("clear clips: %w", err)
	}
	defer tx.Rollback()
	query := `SELECT ` + clipCols + ` FROM clip_items`
	if keepPinned {
		query += ` WHERE pinned = 0`
	}
	items, err := queryClips(ctx, tx, query)
	if err != nil {
		return nil, err
	}
	if err := deleteClipRows(ctx, tx, items); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("clear clips: %w", err)
	}
	return items, nil
}

func (d *DB) PruneClips(ctx context.Context, olderThanMs int64, maxItems int) ([]core.ClipItem, error) {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("prune clips: %w", err)
	}
	defer tx.Rollback()
	removed := []core.ClipItem{}
	if olderThanMs > 0 {
		items, err := queryClips(ctx, tx, `SELECT `+clipCols+` FROM clip_items WHERE pinned = 0 AND last_used_at < ? ORDER BY last_used_at ASC, id ASC`, olderThanMs)
		if err != nil {
			return nil, err
		}
		if err := deleteClipRows(ctx, tx, items); err != nil {
			return nil, err
		}
		removed = append(removed, items...)
	}
	if maxItems > 0 {
		var total int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM clip_items`).Scan(&total); err != nil {
			return nil, fmt.Errorf("prune clips: %w", err)
		}
		if excess := total - maxItems; excess > 0 {
			items, err := queryClips(ctx, tx, `SELECT `+clipCols+` FROM clip_items WHERE pinned = 0 ORDER BY last_used_at ASC, id ASC LIMIT ?`, excess)
			if err != nil {
				return nil, err
			}
			if err := deleteClipRows(ctx, tx, items); err != nil {
				return nil, err
			}
			removed = append(removed, items...)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("prune clips: %w", err)
	}
	return removed, nil
}
