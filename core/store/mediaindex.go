package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"toolbox/core"
	"toolbox/core/mediaindex"
)

// Smart search's tables (migration 0011, SPEC.md §2). Reads use d.ro, writes
// (and reads inside a write transaction) use d.sql.

// MediaIndex returns the index's store.
func (d *DB) MediaIndex() mediaindex.Store { return &mediaStore{d: d} }

type mediaStore struct{ d *DB }

var _ mediaindex.Store = (*mediaStore)(nil)

func (m *mediaStore) GetSetting(ctx context.Context, key string) (string, bool, error) {
	return m.d.GetSetting(ctx, key)
}

func (m *mediaStore) SetSetting(ctx context.Context, key, value string) error {
	return m.d.SetSetting(ctx, key, value)
}

const itemCols = `id, path, source, source_ref, kind, size_bytes, mod_ms, state, speech_state, reason, attempts, model, indexed_at`

type scanner interface{ Scan(dest ...any) error }

func scanItem(s scanner) (mediaindex.Item, error) {
	var it mediaindex.Item
	err := s.Scan(&it.ID, &it.Path, &it.Source, &it.SourceRef, &it.Kind, &it.Size, &it.ModMs, &it.State,
		&it.SpeechState, &it.Reason, &it.Attempts, &it.Model, &it.IndexedAt)
	return it, err
}

func (m *mediaStore) queryItems(ctx context.Context, q string, args ...any) ([]mediaindex.Item, error) {
	rows, err := m.d.ro.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query media items: %w", err)
	}
	defer rows.Close()
	out := []mediaindex.Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, fmt.Errorf("scan media item: %w", err)
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func (m *mediaStore) AllItems(ctx context.Context) ([]mediaindex.Item, error) {
	return m.queryItems(ctx, `SELECT `+itemCols+` FROM media_items ORDER BY id`)
}

func (m *mediaStore) GetItem(ctx context.Context, path string) (mediaindex.Item, bool, error) {
	it, err := scanItem(m.d.ro.QueryRowContext(ctx, `SELECT `+itemCols+` FROM media_items WHERE path = ?`, path))
	if errors.Is(err, sql.ErrNoRows) {
		return it, false, nil
	}
	if err != nil {
		return it, false, fmt.Errorf("get media item: %w", err)
	}
	return it, true, nil
}

// placeholders returns "?,?,?" for n values.
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// chunked calls fn with slices of at most size elements.
func chunked[T any](xs []T, size int, fn func([]T) error) error {
	for len(xs) > 0 {
		n := min(size, len(xs))
		if err := fn(xs[:n]); err != nil {
			return err
		}
		xs = xs[n:]
	}
	return nil
}

func (m *mediaStore) ItemsByIDs(ctx context.Context, ids []int64) (map[int64]mediaindex.Item, error) {
	out := make(map[int64]mediaindex.Item, len(ids))
	err := chunked(ids, 500, func(part []int64) error {
		args := make([]any, len(part))
		for i, id := range part {
			args[i] = id
		}
		items, err := m.queryItems(ctx, `SELECT `+itemCols+` FROM media_items WHERE id IN (`+placeholders(len(part))+`)`, args...)
		for _, it := range items {
			out[it.ID] = it
		}
		return err
	})
	return out, err
}

// clearContent deletes what the index learned about a row (vectors, auto
// labels, every text chunk). User and hidden labels stay.
func clearContent(ctx context.Context, tx *sql.Tx, id int64) error {
	for _, q := range []string{
		`DELETE FROM media_vectors WHERE item_id = ?`,
		`DELETE FROM media_labels WHERE item_id = ? AND source = 'auto'`,
		`DELETE FROM media_text WHERE item_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return fmt.Errorf("clear media item: %w", err)
		}
	}
	return nil
}

func (m *mediaStore) ApplyScan(ctx context.Context, d mediaindex.ScanDelta) error {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin scan: %w", err)
	}
	defer tx.Rollback()

	changed := func(it mediaindex.Item) error {
		var id int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM media_items WHERE path = ?`, it.Path).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return insertItem(ctx, tx, it)
		}
		if err != nil {
			return fmt.Errorf("find media item: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE media_items SET source = ?, source_ref = ?, kind = ?, size_bytes = ?, mod_ms = ?,
			state = ?, speech_state = ?, reason = ?, attempts = 0, model = '', indexed_at = 0 WHERE id = ?`,
			it.Source, it.SourceRef, it.Kind, it.Size, it.ModMs, it.State, it.SpeechState, it.Reason, id); err != nil {
			return fmt.Errorf("update media item: %w", err)
		}
		return clearContent(ctx, tx, id)
	}
	for _, it := range d.Add {
		if err := changed(it); err != nil {
			return err
		}
	}
	for _, it := range d.Changed {
		if err := changed(it); err != nil {
			return err
		}
	}
	for _, p := range d.Remove {
		if _, err := tx.ExecContext(ctx, `DELETE FROM media_items WHERE path = ?`, p); err != nil {
			return fmt.Errorf("remove media item: %w", err)
		}
	}
	return tx.Commit()
}

func insertItem(ctx context.Context, tx *sql.Tx, it mediaindex.Item) error {
	speech := it.SpeechState
	if speech == "" {
		speech = mediaindex.SpeechNone
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO media_items(path, source, source_ref, kind, size_bytes, mod_ms, state, speech_state, reason, attempts, model, indexed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		it.Path, it.Source, it.SourceRef, it.Kind, it.Size, it.ModMs, it.State, speech, it.Reason, it.Attempts, it.Model, it.IndexedAt)
	if err != nil {
		return fmt.Errorf("insert media item: %w", err)
	}
	return nil
}

func (m *mediaStore) EnsureItem(ctx context.Context, it mediaindex.Item) (int64, bool, error) {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, fmt.Errorf("begin ensure item: %w", err)
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM media_items WHERE path = ?`, it.Path).Scan(&id)
	switch {
	case err == nil:
		return id, false, nil
	case !errors.Is(err, sql.ErrNoRows):
		return 0, false, fmt.Errorf("find media item: %w", err)
	}
	if err := insertItem(ctx, tx, it); err != nil {
		return 0, false, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT id FROM media_items WHERE path = ?`, it.Path).Scan(&id); err != nil {
		return 0, false, fmt.Errorf("find media item: %w", err)
	}
	return id, true, tx.Commit()
}

func (m *mediaStore) NextPending(ctx context.Context, limit int) ([]mediaindex.Item, error) {
	return m.queryItems(ctx, `SELECT `+itemCols+` FROM media_items WHERE state = 'pending'
		ORDER BY CASE source WHEN 'library' THEN 0 ELSE 1 END, mod_ms DESC, id DESC LIMIT ?`, limit)
}

func (m *mediaStore) NextSpeech(ctx context.Context, limit int) ([]mediaindex.Item, error) {
	return m.queryItems(ctx, `SELECT `+itemCols+` FROM media_items WHERE speech_state = 'pending'
		ORDER BY size_bytes, id LIMIT ?`, limit)
}

func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

func (m *mediaStore) NameMatches(ctx context.Context, fragment string, limit int) ([]mediaindex.Item, error) {
	return m.queryItems(ctx, `SELECT `+itemCols+` FROM media_items WHERE source = 'library' AND path LIKE ? ESCAPE '\'
		ORDER BY mod_ms DESC LIMIT ?`, "%"+likeEscape(fragment)+"%", limit)
}

func (m *mediaStore) SetItemState(ctx context.Context, path, stage, state, reason string, attempts int) error {
	col := "state"
	if stage == mediaindex.StageSpeech {
		col = "speech_state"
	}
	att := "attempts + ?"
	if attempts < 0 {
		att = "0 * ?"
	}
	_, err := m.d.sql.ExecContext(ctx, `UPDATE media_items SET `+col+` = ?, reason = ?, attempts = `+att+` WHERE path = ?`,
		state, reason, attempts, path)
	if err != nil {
		return fmt.Errorf("set media item state: %w", err)
	}
	return nil
}

func (m *mediaStore) deleteBy(ctx context.Context, where string, keys []string) ([]int64, error) {
	var ids []int64
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin delete: %w", err)
	}
	defer tx.Rollback()
	err = chunked(keys, 400, func(part []string) error {
		args := make([]any, len(part))
		for i, p := range part {
			args[i] = p
		}
		rows, err := tx.QueryContext(ctx, `SELECT id FROM media_items WHERE `+where+` IN (`+placeholders(len(part))+`)`, args...)
		if err != nil {
			return fmt.Errorf("find media items: %w", err)
		}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if _, err := tx.ExecContext(ctx, `DELETE FROM media_items WHERE `+where+` IN (`+placeholders(len(part))+`)`, args...); err != nil {
			return fmt.Errorf("delete media items: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ids, tx.Commit()
}

func (m *mediaStore) DeleteItems(ctx context.Context, paths []string) ([]int64, error) {
	return m.deleteBy(ctx, "path", paths)
}

func (m *mediaStore) DeleteProjectItems(ctx context.Context, refs []string) ([]int64, error) {
	return m.deleteBy(ctx, "source_ref", refs)
}

func (m *mediaStore) RenameItem(ctx context.Context, from, to string) (bool, error) {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin rename: %w", err)
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM media_items WHERE path = ?`, from).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("find media item: %w", err)
	}
	if from != to {
		if _, err := tx.ExecContext(ctx, `DELETE FROM media_items WHERE path = ? AND id <> ?`, to, id); err != nil {
			return false, fmt.Errorf("replace media item: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE media_items SET path = ? WHERE id = ?`, to, id); err != nil {
		return false, fmt.Errorf("rename media item: %w", err)
	}
	return true, tx.Commit()
}

func (m *mediaStore) exec(ctx context.Context, q string, args ...any) (int, error) {
	res, err := m.d.sql.ExecContext(ctx, q, args...)
	if err != nil {
		return 0, fmt.Errorf("update media items: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func (m *mediaStore) MarkAllPending(ctx context.Context) error {
	if _, err := m.exec(ctx, `UPDATE media_items SET state = 'pending', attempts = 0, reason = '' WHERE kind <> 'audio'`); err != nil {
		return err
	}
	_, err := m.exec(ctx, `UPDATE media_items SET speech_state = 'pending', attempts = 0, reason = ''
		WHERE kind IN ('audio','video') AND speech_state <> 'none'`)
	return err
}

func (m *mediaStore) MarkModelStale(ctx context.Context, model string) (int, error) {
	return m.exec(ctx, `UPDATE media_items SET state = 'pending', attempts = 0 WHERE state = 'done' AND model <> '' AND model <> ?`, model)
}

func (m *mediaStore) MarkTextKindsPending(ctx context.Context) (int, error) {
	return m.exec(ctx, `UPDATE media_items SET state = 'pending', attempts = 0 WHERE state = 'done' AND kind IN ('image','video','pdf')`)
}

func (m *mediaStore) EnableSpeech(ctx context.Context) (int, error) {
	return m.exec(ctx, `UPDATE media_items SET speech_state = 'pending' WHERE kind IN ('audio','video') AND speech_state = 'none'`)
}

func (m *mediaStore) ResetFailed(ctx context.Context) (int, error) {
	a, err := m.exec(ctx, `UPDATE media_items SET state = 'pending' WHERE state = 'failed' AND attempts < 2`)
	if err != nil {
		return 0, err
	}
	b, err := m.exec(ctx, `UPDATE media_items SET speech_state = 'pending' WHERE speech_state = 'failed' AND attempts < 2`)
	return a + b, err
}

func (m *mediaStore) DeleteAll(ctx context.Context) error {
	_, err := m.exec(ctx, `DELETE FROM media_items`)
	return err
}

var textSources = map[string]bool{
	core.TextSourceOCR: true, core.TextSourcePDF: true, core.TextSourceDoc: true,
	core.TextSourceSpeech: true, core.TextSourceSubs: true, core.TextSourceCaption: true,
}

func insertTexts(ctx context.Context, tx *sql.Tx, id int64, chunks []core.MediaText) error {
	for _, c := range chunks {
		if !textSources[c.Source] || strings.TrimSpace(c.Text) == "" {
			continue
		}
		end := c.EndPos
		if end == 0 && c.Pos == 0 {
			end = -1
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO media_text(item_id, source, pos, end_pos, text) VALUES (?, ?, ?, ?, ?)`,
			id, c.Source, c.Pos, end, c.Text); err != nil {
			return fmt.Errorf("insert media text: %w", err)
		}
	}
	return nil
}

func deleteTextSources(ctx context.Context, tx *sql.Tx, id int64, sources []string) error {
	if len(sources) == 0 {
		return nil
	}
	args := []any{id}
	for _, s := range sources {
		args = append(args, s)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM media_text WHERE item_id = ? AND source IN (`+placeholders(len(sources))+`)`, args...); err != nil {
		return fmt.Errorf("delete media text: %w", err)
	}
	return nil
}

func (m *mediaStore) StoreBatch(ctx context.Context, items []mediaindex.BatchItem) ([]int64, error) {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin batch: %w", err)
	}
	defer tx.Rollback()
	ids := make([]int64, len(items))
	now := core.NowMillis()
	for i, b := range items {
		var id, size, mod int64
		err := tx.QueryRowContext(ctx, `SELECT id, size_bytes, mod_ms FROM media_items WHERE path = ?`, b.Path).Scan(&id, &size, &mod)
		if errors.Is(err, sql.ErrNoRows) {
			continue // removed meanwhile
		}
		if err != nil {
			return nil, fmt.Errorf("find media item: %w", err)
		}
		if b.ModMs != 0 && (b.ModMs != mod || b.Size != size) {
			continue // changed while it was read; the scan will redo it
		}
		switch b.State {
		case mediaindex.StateDone:
			if _, err := tx.ExecContext(ctx, `UPDATE media_items SET state = 'done', reason = '', attempts = 0, model = ?, indexed_at = ? WHERE id = ?`,
				b.Model, now, id); err != nil {
				return nil, fmt.Errorf("update media item: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM media_vectors WHERE item_id = ?`, id); err != nil {
				return nil, fmt.Errorf("delete media vectors: %w", err)
			}
			for _, v := range b.Vectors {
				if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO media_vectors(item_id, pos, vec) VALUES (?, ?, ?)`, id, v.Pos, v.Blob); err != nil {
					return nil, fmt.Errorf("insert media vector: %w", err)
				}
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM media_labels WHERE item_id = ? AND source = 'auto'`, id); err != nil {
				return nil, fmt.Errorf("delete auto labels: %w", err)
			}
			for _, l := range b.Labels {
				if _, err := tx.ExecContext(ctx, `INSERT INTO media_labels(item_id, label, source, score, pos) VALUES (?, ?, 'auto', ?, ?)
					ON CONFLICT(item_id, label) DO NOTHING`, id, l.Label, l.Score, l.Pos); err != nil {
					return nil, fmt.Errorf("insert media label: %w", err)
				}
			}
			if err := deleteTextSources(ctx, tx, id, b.TextSources); err != nil {
				return nil, err
			}
			if err := insertTexts(ctx, tx, id, b.Texts); err != nil {
				return nil, err
			}
			if b.SpeechState != "" {
				if _, err := tx.ExecContext(ctx, `UPDATE media_items SET speech_state = ? WHERE id = ?`, b.SpeechState, id); err != nil {
					return nil, fmt.Errorf("update speech state: %w", err)
				}
			}
		case mediaindex.StateFailed:
			if _, err := tx.ExecContext(ctx, `UPDATE media_items SET state = 'failed', reason = ?, attempts = attempts + 1, indexed_at = ? WHERE id = ?`,
				b.Reason, now, id); err != nil {
				return nil, fmt.Errorf("update media item: %w", err)
			}
		case mediaindex.StateSkipped:
			if _, err := tx.ExecContext(ctx, `UPDATE media_items SET state = 'skipped', reason = ?, indexed_at = ? WHERE id = ?`,
				b.Reason, now, id); err != nil {
				return nil, fmt.Errorf("update media item: %w", err)
			}
		default:
			return nil, fmt.Errorf("store batch: unknown state %q", b.State)
		}
		ids[i] = id
	}
	return ids, tx.Commit()
}

func (m *mediaStore) StoreSpeech(ctx context.Context, w mediaindex.SpeechWrite) (bool, error) {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin speech: %w", err)
	}
	defer tx.Rollback()
	var id, size, mod int64
	err = tx.QueryRowContext(ctx, `SELECT id, size_bytes, mod_ms FROM media_items WHERE path = ?`, w.Path).Scan(&id, &size, &mod)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("find media item: %w", err)
	}
	if w.ModMs != 0 && (w.ModMs != mod || w.Size != size) {
		return false, nil
	}
	switch w.State {
	case mediaindex.SpeechDone, mediaindex.SpeechNoSpeech:
		if err := deleteTextSources(ctx, tx, id, []string{core.TextSourceSpeech, core.TextSourceSubs}); err != nil {
			return false, err
		}
		if err := insertTexts(ctx, tx, id, w.Chunks); err != nil {
			return false, err
		}
		_, err = tx.ExecContext(ctx, `UPDATE media_items SET speech_state = ?, reason = '', attempts = 0, indexed_at = ? WHERE id = ?`, w.State, core.NowMillis(), id)
	case mediaindex.SpeechFailed:
		_, err = tx.ExecContext(ctx, `UPDATE media_items SET speech_state = 'failed', reason = ?, attempts = attempts + 1, indexed_at = ? WHERE id = ?`, w.Reason, core.NowMillis(), id)
	case mediaindex.SpeechSkipped:
		_, err = tx.ExecContext(ctx, `UPDATE media_items SET speech_state = 'skipped', reason = ?, indexed_at = ? WHERE id = ?`, w.Reason, core.NowMillis(), id)
	default:
		return false, fmt.Errorf("store speech: unknown state %q", w.State)
	}
	if err != nil {
		return false, fmt.Errorf("update speech state: %w", err)
	}
	return true, tx.Commit()
}

func (m *mediaStore) ItemVectors(ctx context.Context, itemID int64) ([]mediaindex.VecRow, error) {
	rows, err := m.d.ro.QueryContext(ctx, `SELECT pos, vec FROM media_vectors WHERE item_id = ? ORDER BY pos`, itemID)
	if err != nil {
		return nil, fmt.Errorf("query media vectors: %w", err)
	}
	defer rows.Close()
	out := []mediaindex.VecRow{}
	for rows.Next() {
		var v mediaindex.VecRow
		if err := rows.Scan(&v.Pos, &v.Blob); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (m *mediaStore) StreamVectors(ctx context.Context, model string, fn func(itemID, pos int64, blob []byte) error) error {
	rows, err := m.d.ro.QueryContext(ctx, `SELECT v.item_id, v.pos, v.vec FROM media_vectors v
		JOIN media_items i ON i.id = v.item_id WHERE i.model = ? ORDER BY v.item_id, v.pos`, model)
	if err != nil {
		return fmt.Errorf("stream media vectors: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, pos int64
		var blob []byte
		if err := rows.Scan(&id, &pos, &blob); err != nil {
			return err
		}
		if err := fn(id, pos, blob); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (m *mediaStore) VectorCount(ctx context.Context, model string) (int, error) {
	var n int
	err := m.d.ro.QueryRowContext(ctx, `SELECT count(*) FROM media_vectors v JOIN media_items i ON i.id = v.item_id WHERE i.model = ?`, model).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count media vectors: %w", err)
	}
	return n, nil
}

func (m *mediaStore) DoneItemIDs(ctx context.Context, model string, afterID int64, limit int) ([]int64, error) {
	rows, err := m.d.ro.QueryContext(ctx, `SELECT id FROM media_items WHERE model = ? AND id > ? ORDER BY id LIMIT ?`, model, afterID, limit)
	if err != nil {
		return nil, fmt.Errorf("list media items: %w", err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (m *mediaStore) ItemLabels(ctx context.Context, itemID int64) ([]mediaindex.LabelRow, error) {
	rows, err := m.d.ro.QueryContext(ctx, `SELECT label, source, score, pos FROM media_labels WHERE item_id = ?
		ORDER BY (source = 'user') DESC, score DESC, label`, itemID)
	if err != nil {
		return nil, fmt.Errorf("query media labels: %w", err)
	}
	defer rows.Close()
	out := []mediaindex.LabelRow{}
	for rows.Next() {
		var l mediaindex.LabelRow
		if err := rows.Scan(&l.Label, &l.Source, &l.Score, &l.Pos); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (m *mediaStore) SetLabel(ctx context.Context, itemID int64, r mediaindex.LabelRow) error {
	_, err := m.d.sql.ExecContext(ctx, `INSERT INTO media_labels(item_id, label, source, score, pos) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(item_id, label) DO UPDATE SET source = excluded.source, score = excluded.score, pos = excluded.pos`,
		itemID, r.Label, r.Source, r.Score, r.Pos)
	if err != nil {
		return fmt.Errorf("set media label: %w", err)
	}
	return nil
}

func (m *mediaStore) DeleteLabel(ctx context.Context, itemID int64, label string) error {
	_, err := m.d.sql.ExecContext(ctx, `DELETE FROM media_labels WHERE item_id = ? AND label = ?`, itemID, label)
	if err != nil {
		return fmt.Errorf("delete media label: %w", err)
	}
	return nil
}

func (m *mediaStore) ReplaceAutoLabels(ctx context.Context, itemID int64, rows []mediaindex.LabelRow) error {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin labels: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM media_labels WHERE item_id = ? AND source = 'auto'`, itemID); err != nil {
		return fmt.Errorf("delete auto labels: %w", err)
	}
	for _, l := range rows {
		if _, err := tx.ExecContext(ctx, `INSERT INTO media_labels(item_id, label, source, score, pos) VALUES (?, ?, 'auto', ?, ?)
			ON CONFLICT(item_id, label) DO NOTHING`, itemID, l.Label, l.Score, l.Pos); err != nil {
			return fmt.Errorf("insert media label: %w", err)
		}
	}
	return tx.Commit()
}

func (m *mediaStore) LabelStats(ctx context.Context) ([]mediaindex.LabelStat, error) {
	rows, err := m.d.ro.QueryContext(ctx, `WITH r AS (
		SELECT l.label, l.source, l.score, i.path,
		       row_number() OVER (PARTITION BY l.label ORDER BY (l.source = 'user') DESC, l.score DESC, i.id DESC) rn
		FROM media_labels l JOIN media_items i ON i.id = l.item_id WHERE l.source <> 'hidden')
		SELECT label, count(*), sum(source = 'user'), max(CASE WHEN rn = 1 THEN path END), max(CASE WHEN rn = 1 THEN score END)
		FROM r GROUP BY label`)
	if err != nil {
		return nil, fmt.Errorf("query label stats: %w", err)
	}
	defer rows.Close()
	out := []mediaindex.LabelStat{}
	for rows.Next() {
		var s mediaindex.LabelStat
		var cover sql.NullString
		var score sql.NullFloat64
		if err := rows.Scan(&s.Label, &s.Count, &s.User, &cover, &score); err != nil {
			return nil, err
		}
		s.Cover, s.CoverScore = cover.String, score.Float64
		out = append(out, s)
	}
	return out, rows.Err()
}

func (m *mediaStore) ItemsWithLabels(ctx context.Context, labels []string) (map[int64]float64, error) {
	out := map[int64]float64{}
	if len(labels) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(labels)+1)
	for _, l := range labels {
		args = append(args, l)
	}
	args = append(args, len(labels))
	rows, err := m.d.ro.QueryContext(ctx, `SELECT item_id, avg(score) FROM media_labels
		WHERE label IN (`+placeholders(len(labels))+`) AND source <> 'hidden' GROUP BY item_id HAVING count(*) = ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("query items by labels: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var score float64
		if err := rows.Scan(&id, &score); err != nil {
			return nil, err
		}
		out[id] = score
	}
	return out, rows.Err()
}

func (m *mediaStore) LabelRows(ctx context.Context, label string) ([]mediaindex.ItemLabel, error) {
	rows, err := m.d.ro.QueryContext(ctx, `SELECT item_id, source, score, pos FROM media_labels WHERE label = ? AND source <> 'hidden'`, label)
	if err != nil {
		return nil, fmt.Errorf("query label rows: %w", err)
	}
	defer rows.Close()
	var out []mediaindex.ItemLabel
	for rows.Next() {
		var l mediaindex.ItemLabel
		if err := rows.Scan(&l.ItemID, &l.Source, &l.Score, &l.Pos); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (m *mediaStore) ItemTexts(ctx context.Context, itemID int64) ([]core.MediaText, error) {
	rows, err := m.d.ro.QueryContext(ctx, `SELECT source, pos, end_pos, text FROM media_text WHERE item_id = ? ORDER BY source, pos, id`, itemID)
	if err != nil {
		return nil, fmt.Errorf("query media text: %w", err)
	}
	defer rows.Close()
	out := []core.MediaText{}
	for rows.Next() {
		var t core.MediaText
		if err := rows.Scan(&t.Source, &t.Pos, &t.EndPos, &t.Text); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (m *mediaStore) ReplaceText(ctx context.Context, itemID int64, sources []string, chunks []core.MediaText) error {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin text: %w", err)
	}
	defer tx.Rollback()
	if err := deleteTextSources(ctx, tx, itemID, sources); err != nil {
		return err
	}
	if err := insertTexts(ctx, tx, itemID, chunks); err != nil {
		return err
	}
	return tx.Commit()
}

func (m *mediaStore) SearchText(ctx context.Context, match string, limit int) ([]mediaindex.TextRow, error) {
	rows, err := m.d.ro.QueryContext(ctx, `SELECT t.item_id, t.source, t.pos, t.end_pos,
		snippet(media_text_fts, 0, char(2), char(3), '…', 12), bm25(media_text_fts)
		FROM media_text_fts JOIN media_text t ON t.id = media_text_fts.rowid
		WHERE media_text_fts MATCH ? ORDER BY bm25(media_text_fts) LIMIT ?`, match, limit)
	if err != nil {
		return nil, fmt.Errorf("search media text: %w", err)
	}
	defer rows.Close()
	var out []mediaindex.TextRow
	for rows.Next() {
		var r mediaindex.TextRow
		if err := rows.Scan(&r.ItemID, &r.Source, &r.Pos, &r.EndPos, &r.Snippet, &r.Rank); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (m *mediaStore) GetTextVector(ctx context.Context, model, text string) ([]byte, bool, error) {
	var blob []byte
	var used int64
	err := m.d.ro.QueryRowContext(ctx, `SELECT vec, used_at FROM media_text_vectors WHERE model = ? AND text = ?`, model, text).Scan(&blob, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("get text vector: %w", err)
	}
	if used > 0 {
		now := core.NowMillis()
		if now-used > 60_000 { // keep the LRU roughly right without a write per query
			_, _ = m.d.sql.ExecContext(ctx, `UPDATE media_text_vectors SET used_at = ? WHERE model = ? AND text = ?`, now, model, text)
		}
	}
	return blob, true, nil
}

// maxQueryVectors is how many query vectors the cache keeps.
const maxQueryVectors = 500

func (m *mediaStore) PutTextVector(ctx context.Context, model, text string, blob []byte, keep bool) error {
	tx, err := m.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin text vector: %w", err)
	}
	defer tx.Rollback()
	used := core.NowMillis()
	upd := `used_at = CASE WHEN media_text_vectors.used_at = 0 THEN 0 ELSE excluded.used_at END`
	if keep {
		used = 0
		upd = `used_at = 0`
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO media_text_vectors(model, text, vec, used_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(model, text) DO UPDATE SET vec = excluded.vec, `+upd, model, text, blob, used); err != nil {
		return fmt.Errorf("put text vector: %w", err)
	}
	if !keep {
		if _, err := tx.ExecContext(ctx, `DELETE FROM media_text_vectors WHERE used_at > 0 AND rowid NOT IN (
			SELECT rowid FROM media_text_vectors WHERE used_at > 0 ORDER BY used_at DESC, rowid DESC LIMIT ?)`, maxQueryVectors); err != nil {
			return fmt.Errorf("prune text vectors: %w", err)
		}
	}
	return tx.Commit()
}

func (m *mediaStore) Counts(ctx context.Context) (mediaindex.Counts, error) {
	var c mediaindex.Counts
	rows, err := m.d.ro.QueryContext(ctx, `SELECT state, count(*) FROM media_items GROUP BY state`)
	if err != nil {
		return c, fmt.Errorf("count media items: %w", err)
	}
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			rows.Close()
			return c, err
		}
		c.Total += n
		switch st {
		case mediaindex.StateDone:
			c.Done = n
		case mediaindex.StatePending:
			c.Pending = n
		case mediaindex.StateFailed:
			c.Failed = n
		case mediaindex.StateSkipped:
			c.Skipped = n
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return c, err
	}
	rows, err = m.d.ro.QueryContext(ctx, `SELECT speech_state, count(*) FROM media_items WHERE speech_state IN ('pending','done') GROUP BY speech_state`)
	if err != nil {
		return c, fmt.Errorf("count speech: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			return c, err
		}
		if st == mediaindex.SpeechPending {
			c.SpeechPending = n
		} else {
			c.SpeechDone = n
		}
	}
	return c, rows.Err()
}

func (m *mediaStore) Failures(ctx context.Context, limit int) ([]mediaindex.Item, error) {
	return m.queryItems(ctx, `SELECT `+itemCols+` FROM media_items
		WHERE state IN ('failed','skipped') OR speech_state IN ('failed','skipped')
		ORDER BY indexed_at DESC, id DESC LIMIT ?`, limit)
}

func (m *mediaStore) IndexBytes(ctx context.Context) (int64, error) {
	var n int64
	err := m.d.ro.QueryRowContext(ctx, `SELECT
		(SELECT coalesce(sum(length(vec)), 0) FROM media_vectors) +
		(SELECT coalesce(sum(length(text)), 0) FROM media_text) * 2 +
		(SELECT count(*) FROM media_items) * 200 +
		(SELECT count(*) FROM media_labels) * 40`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("measure media index: %w", err)
	}
	return n, nil
}
