package composer

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneDir(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	mk := func(name string, size int, age time.Duration) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
		at := now.Add(-age)
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
		return p
	}
	stale := mk("stale.jpg", 10, 40*24*time.Hour)
	oldest := mk("oldest.jpg", 100, 3*time.Hour)
	newer := mk("newer.jpg", 100, time.Hour)
	pruneDir(dir, now, 30*24*time.Hour, 150)
	for p, want := range map[string]bool{stale: false, oldest: false, newer: true} {
		_, err := os.Stat(p)
		if got := err == nil; got != want {
			t.Errorf("%s kept = %v, want %v", filepath.Base(p), got, want)
		}
	}
	pruneDir("", now, time.Hour, 1) // no dir: no-op
}
