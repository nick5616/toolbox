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
	sql *sql.DB // writer: one connection, BEGIN IMMEDIATE
	ro  *sql.DB // read-only pool (WAL readers never wait for the writer)
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
	db, err := sql.Open("sqlite", dsn(abs, false))
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
	ro, err := sql.Open("sqlite", dsn(abs, true))
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("open database (read pool): %w", err)
	}
	ro.SetMaxOpenConns(readPoolSize)
	ro.SetMaxIdleConns(readPoolSize)
	if err := ro.Ping(); err != nil {
		ro.Close()
		db.Close()
		return nil, fmt.Errorf("open database %q (read pool): %w", path, err)
	}
	return &DB{sql: db, ro: ro}, nil
}

const readPoolSize = 4

// dsn builds a file: URI with pragmas. The path is percent-encoded so spaces
// and backslash-converted Windows paths survive. readOnly gives the reader
// pool's connections (query_only); the writer takes the write lock up front.
func dsn(abs string, readOnly bool) string {
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // C:/x -> /C:/x
	}
	u := url.URL{Scheme: "file", Path: p}
	q := url.Values{}
	pragmas := []string{"busy_timeout(5000)", "journal_mode(WAL)", "foreign_keys(1)", "synchronous(NORMAL)",
		"cache_size(-16000)", "temp_store(MEMORY)", "journal_size_limit(67108864)"}
	if readOnly {
		pragmas = append(pragmas, "query_only(1)")
	} else {
		q.Set("_txlock", "immediate")
	}
	for _, pr := range pragmas {
		q.Add("_pragma", pr)
	}
	return u.String() + "?" + q.Encode()
}

// Close closes the database (letting SQLite refresh its planner statistics).
func (d *DB) Close() error {
	_, _ = d.sql.Exec(`PRAGMA optimize`)
	err := d.ro.Close()
	if e := d.sql.Close(); err == nil {
		err = e
	}
	return err
}
