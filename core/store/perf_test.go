package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
)

// The first backfill pass sets a flag; later starts skip the scan.
func TestBackfillLineageRunsOnce(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	if n, err := db.BackfillLineage(ctx); err != nil || n != 0 {
		t.Fatalf("empty pass: %d %v", n, err)
	}
	// A job whose output has no lineage row now: the flag says "already done".
	j := mkJob("j1", "m", core.JobDone, 1)
	j.Inputs = []string{"/in/one.jpg"}
	if err := db.InsertJob(ctx, j); err != nil {
		t.Fatal(err)
	}
	putOut(t, db, "/lib/one-x.png", "j1", "m", 1, 1, core.KindImage)
	if n, err := db.BackfillLineage(ctx); err != nil || n != 0 {
		t.Fatalf("second pass must be skipped: %d %v", n, err)
	}
}

// Reads go to the reader pool: they see committed writes and are not blocked
// by an open write transaction.
func TestReadsDuringWriteTx(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	if err := db.SetSetting(ctx, "k", "v1"); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := db.GetSetting(ctx, "k"); err != nil || !ok || v != "v1" {
		t.Fatalf("read after write: %q %v %v", v, ok, err)
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE settings SET value='v2' WHERE key='k'`); err != nil {
		t.Fatal(err)
	}
	if v, _, err := db.GetSetting(ctx, "k"); err != nil || v != "v1" {
		t.Fatalf("reader during write tx: %q %v (want the committed v1)", v, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if v, _, _ := db.GetSetting(ctx, "k"); v != "v2" {
		t.Fatalf("after commit: %q", v)
	}
	// The reader pool is read-only.
	if _, err := db.ro.ExecContext(ctx, `DELETE FROM settings`); err == nil {
		t.Fatal("reader connection accepted a write")
	}
}

// Missing detection stats files in parallel but keeps each output's own flag.
func TestQueryOutputsMissingFlags(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	dir := t.TempDir()
	const n = 40
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%02d.png", i))
		if i%3 != 0 {
			if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		putOut(t, db, p, "", "m", int64(i), 1, core.KindImage)
	}
	for i := 0; i < n; i++ {
		o, ok, err := db.OutputByPath(ctx, filepath.Join(dir, fmt.Sprintf("f%02d.png", i)))
		if err != nil || !ok {
			t.Fatal(err)
		}
		if o.Missing != (i%3 == 0) {
			t.Fatalf("f%02d: Missing=%v", i, o.Missing)
		}
	}
}
