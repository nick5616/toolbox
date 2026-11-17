package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"toolbox/core"
	"toolbox/core/focus"
)

// Focus Lock persistence (SPEC.md §2.2, migration 0008). Settings live in
// the settings table under "focus".

const focusSettingsKey = "focus"

// FocusStore returns the focus.Store backed by this database.
func (d *DB) FocusStore() focus.Store { return &focusStore{d: d} }

type focusStore struct{ d *DB }

var _ focus.Store = (*focusStore)(nil)

func (f *focusStore) Profiles(ctx context.Context) ([]focus.Profile, error) {
	rows, err := f.d.ro.QueryContext(ctx, `SELECT json FROM focus_profiles ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, fmt.Errorf("list focus profiles: %w", err)
	}
	defer rows.Close()
	out := []focus.Profile{}
	for rows.Next() {
		var js string
		if err := rows.Scan(&js); err != nil {
			return nil, fmt.Errorf("scan focus profile: %w", err)
		}
		var p focus.Profile
		if err := json.Unmarshal([]byte(js), &p); err != nil {
			return nil, fmt.Errorf("decode focus profile: %w", err)
		}
		if p.Rules == nil {
			p.Rules = []focus.AllowRule{}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (f *focusStore) PutProfile(ctx context.Context, p focus.Profile) error {
	if p.Rules == nil {
		p.Rules = []focus.AllowRule{}
	}
	js, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("encode focus profile: %w", err)
	}
	_, err = f.d.sql.ExecContext(ctx, `INSERT INTO focus_profiles(id, name, json, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json, updated_at = excluded.updated_at`,
		p.ID, p.Name, string(js), p.UpdatedAt)
	if err != nil {
		return fmt.Errorf("put focus profile: %w", err)
	}
	return nil
}

func (f *focusStore) DeleteProfile(ctx context.Context, id string) error {
	if _, err := f.d.sql.ExecContext(ctx, `DELETE FROM focus_profiles WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete focus profile: %w", err)
	}
	return nil
}

func decodeSession(js string) (focus.Session, error) {
	var s focus.Session
	if err := json.Unmarshal([]byte(js), &s); err != nil {
		return focus.Session{}, fmt.Errorf("decode focus session: %w", err)
	}
	if s.Always == nil {
		s.Always = []focus.AllowRule{}
	}
	if s.Extra == nil {
		s.Extra = []focus.AllowRule{}
	}
	if s.Launched == nil {
		s.Launched = []focus.AllowRule{}
	}
	if s.Profile.Rules == nil {
		s.Profile.Rules = []focus.AllowRule{}
	}
	return s, nil
}

func (f *focusStore) ActiveSession(ctx context.Context) (*focus.Session, error) {
	var js string
	err := f.d.ro.QueryRowContext(ctx,
		`SELECT json FROM focus_sessions WHERE ended_at = 0 ORDER BY started_at DESC LIMIT 1`).Scan(&js)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("active focus session: %w", err)
	}
	s, err := decodeSession(js)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (f *focusStore) PutSession(ctx context.Context, s focus.Session) error {
	js, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("encode focus session: %w", err)
	}
	_, err = f.d.sql.ExecContext(ctx, `INSERT INTO focus_sessions(id, started_at, ended_at, json) VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, json = excluded.json`,
		s.ID, s.StartedAt, s.EndedAt, string(js))
	if err != nil {
		return fmt.Errorf("put focus session: %w", err)
	}
	return nil
}

func (f *focusStore) RecentSessions(ctx context.Context, limit int) ([]focus.Session, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := f.d.ro.QueryContext(ctx,
		`SELECT json FROM focus_sessions WHERE ended_at > 0 ORDER BY started_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("recent focus sessions: %w", err)
	}
	defer rows.Close()
	out := []focus.Session{}
	for rows.Next() {
		var js string
		if err := rows.Scan(&js); err != nil {
			return nil, fmt.Errorf("scan focus session: %w", err)
		}
		s, err := decodeSession(js)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (f *focusStore) AddEvents(ctx context.Context, evs []focus.BlockEvent) error {
	if len(evs) == 0 {
		return nil
	}
	tx, err := f.d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("add focus events: %w", err)
	}
	defer tx.Rollback()
	for _, e := range evs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO focus_events(session_id, at, path, name, result, error) VALUES (?, ?, ?, ?, ?, ?)`,
			e.SessionID, e.At, e.Path, e.Name, e.Result, e.Error); err != nil {
			return fmt.Errorf("add focus event: %w", err)
		}
	}
	return tx.Commit()
}

func (f *focusStore) Events(ctx context.Context, sessionID string, limit int) ([]focus.BlockEvent, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := f.d.ro.QueryContext(ctx, `SELECT session_id, at, path, name, result, error FROM focus_events
		WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, fmt.Errorf("focus events: %w", err)
	}
	defer rows.Close()
	out := []focus.BlockEvent{}
	for rows.Next() {
		var e focus.BlockEvent
		if err := rows.Scan(&e.SessionID, &e.At, &e.Path, &e.Name, &e.Result, &e.Error); err != nil {
			return nil, fmt.Errorf("scan focus event: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (f *focusStore) LearnEntries(ctx context.Context, since int64) ([]focus.LearnEntry, error) {
	rows, err := f.d.ro.QueryContext(ctx, `SELECT path, MAX(name), COUNT(*), MAX(at) FROM focus_events
		WHERE session_id = '' AND result = ? AND at >= ? GROUP BY path ORDER BY MAX(at) DESC, path`,
		focus.ResultWouldStop, since)
	if err != nil {
		return nil, fmt.Errorf("learn entries: %w", err)
	}
	defer rows.Close()
	out := []focus.LearnEntry{}
	for rows.Next() {
		var e focus.LearnEntry
		if err := rows.Scan(&e.Path, &e.Name, &e.Count, &e.LastSeen); err != nil {
			return nil, fmt.Errorf("scan learn entry: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (f *focusStore) ClearLearn(ctx context.Context, path string) error {
	q := `DELETE FROM focus_events WHERE session_id = '' AND result = ?`
	args := []any{focus.ResultWouldStop}
	if path != "" {
		q += ` AND path = ?`
		args = append(args, path)
	}
	if _, err := f.d.sql.ExecContext(ctx, q, args...); err != nil {
		return fmt.Errorf("clear learn: %w", err)
	}
	return nil
}

func (f *focusStore) PruneEvents(ctx context.Context, before int64, keep int) error {
	if _, err := f.d.sql.ExecContext(ctx, `DELETE FROM focus_events WHERE at < ?`, before); err != nil {
		return fmt.Errorf("prune focus events: %w", err)
	}
	if keep > 0 {
		if _, err := f.d.sql.ExecContext(ctx, `DELETE FROM focus_events WHERE id NOT IN
			(SELECT id FROM focus_events ORDER BY id DESC LIMIT ?)`, keep); err != nil {
			return fmt.Errorf("prune focus events: %w", err)
		}
	}
	return nil
}

func (f *focusStore) GetSettings(ctx context.Context) (focus.Settings, bool, error) {
	v, ok, err := f.d.GetSetting(ctx, focusSettingsKey)
	if err != nil || !ok {
		return focus.Settings{}, false, err
	}
	s := focus.DefaultSettings()
	if err := json.NewDecoder(strings.NewReader(v)).Decode(&s); err != nil {
		return focus.Settings{}, false, fmt.Errorf("decode focus settings: %w", err)
	}
	if s.AlwaysAllowed == nil {
		s.AlwaysAllowed = []focus.AllowRule{}
	}
	return s, true, nil
}

func (f *focusStore) PutSettings(ctx context.Context, s focus.Settings) error {
	if s.AlwaysAllowed == nil {
		s.AlwaysAllowed = []focus.AllowRule{}
	}
	js, err := json.Marshal(s)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save Focus settings").WithCause(err)
	}
	return f.d.SetSetting(ctx, focusSettingsKey, string(js))
}
