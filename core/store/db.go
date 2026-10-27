// Package store is the SQLite implementation of core.JobStore,
// core.OutputStore and core.SettingsStore. See SPEC.md §5.
package store

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

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
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create database dir: %w", err)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	db, err := sql.Open("sqlite", dsn(abs))
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open database %q: %w", path, err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &DB{sql: db}, nil
}

// dsn builds a file: URI with pragmas. The path is percent-encoded so spaces
// and backslash-converted Windows paths survive.
func dsn(abs string) string {
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // C:/x -> /C:/x
	}
	u := url.URL{Scheme: "file", Path: p}
	q := url.Values{}
	for _, pr := range []string{"busy_timeout(5000)", "journal_mode(WAL)", "foreign_keys(1)", "synchronous(NORMAL)"} {
		q.Add("_pragma", pr)
	}
	return u.String() + "?" + q.Encode()
}

// Close closes the database.
func (d *DB) Close() error { return d.sql.Close() }
