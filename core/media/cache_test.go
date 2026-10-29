package media

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProxyPathKey(t *testing.T) {
	a := proxyPath("/c", "/x/a.mkv", 10, 1, false)
	if a != proxyPath("/c", "/x/a.mkv", 10, 1, false) {
		t.Error("not stable")
	}
	if a == proxyPath("/c", "/x/a.mkv", 10, 2, false) || a == proxyPath("/c", "/x/a.mkv", 11, 1, false) {
		t.Error("key ignores mtime or size")
	}
	if filepath.Ext(a) != ".mp4" || filepath.Ext(proxyPath("/c", "/x/a.mkv", 10, 1, true)) != ".m4a" {
		t.Error("extensions")
	}
	if filepath.Base(filepath.Dir(a)) != "proxy" {
		t.Error("dir")
	}
}

func TestPruneOldestFirst(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	names := []string{"proxy/a.mp4", "strip/b.jpg", "frame/c.jpg", "wave/d.bin"}
	for i, n := range names {
		p := filepath.Join(dir, n)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, make([]byte, 100), 0o644)
		mt := base.Add(time.Duration(i) * time.Minute)
		_ = os.Chtimes(p, mt, mt)
	}
	pruneCache(dir, 250) // total 400: the two oldest go
	for i, n := range names {
		_, err := os.Stat(filepath.Join(dir, n))
		if gone := err != nil; gone != (i < 2) {
			t.Errorf("%s gone=%v", n, gone)
		}
	}
	pruneCache(filepath.Join(dir, "missing"), 1) // no panic
}
