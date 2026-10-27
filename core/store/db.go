// Package store is the SQLite implementation of core.JobStore,
// core.OutputStore and core.SettingsStore. See SPEC.md §5.
//
// CONTRACT STUB (foundation). WP-A replaces the bodies; exported signatures
// are frozen.
package store

import (
	"context"
	"database/sql"

	"toolbox/core"

	_ "modernc.org/sqlite" // pure-Go driver "sqlite"
)

// DB is the app database.
type DB struct {
	sql *sql.DB
}

var (
	_ core.JobStore      = (*DB)(nil)
	_ core.OutputStore   = (*DB)(nil)
	_ core.SettingsStore = (*DB)(nil)
)

// Open opens (creating if needed) and migrates the database at path.
func Open(path string) (*DB, error) {
	return &DB{}, nil
}

// Close closes the database.
func (d *DB) Close() error { return nil }

func (d *DB) InsertJob(ctx context.Context, j core.Job) error { return core.NotImplemented("store") }
func (d *DB) UpdateJob(ctx context.Context, j core.Job) error { return core.NotImplemented("store") }
func (d *DB) GetJob(ctx context.Context, id string) (core.Job, error) {
	return core.Job{}, core.NotImplemented("store")
}
func (d *DB) ListJobs(ctx context.Context, f core.JobFilter) ([]core.Job, error) {
	return []core.Job{}, nil
}
func (d *DB) DeleteJobs(ctx context.Context, ids []string) error { return core.NotImplemented("store") }
func (d *DB) AppendLogs(ctx context.Context, jobID string, lines []core.LogLine) error {
	return core.NotImplemented("store")
}
func (d *DB) Logs(ctx context.Context, jobID string) ([]core.LogLine, error) {
	return []core.LogLine{}, nil
}
func (d *DB) CountLogs(ctx context.Context, jobID string) (int, error) { return 0, nil }

func (d *DB) UpsertOutput(ctx context.Context, o core.Output) (core.Output, error) {
	return core.Output{}, core.NotImplemented("store")
}
func (d *DB) GetOutput(ctx context.Context, id string) (core.Output, error) {
	return core.Output{}, core.NotImplemented("store")
}
func (d *DB) ListOutputs(ctx context.Context, q core.OutputQuery) (core.OutputPage, error) {
	return core.OutputPage{Items: []core.Output{}}, nil
}
func (d *DB) DeleteOutput(ctx context.Context, id string) error { return core.NotImplemented("store") }

func (d *DB) GetSetting(ctx context.Context, key string) (string, bool, error) {
	return "", false, nil
}
func (d *DB) SetSetting(ctx context.Context, key, value string) error {
	return core.NotImplemented("store")
}
