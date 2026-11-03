package editstudio

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// cacheFolder makes root/name with a file of size bytes and the given age.
func cacheFolder(t *testing.T, root, name string, size int, age time.Duration) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "v540-30.h264"), make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
	mt := time.Now().Add(-age)
	if err := os.Chtimes(dir, mt, mt); err != nil {
		t.Fatal(err)
	}
	return dir
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func TestPruneSrc(t *testing.T) {
	day := 24 * time.Hour
	t.Run("a missing folder is fine", func(t *testing.T) {
		pruneSrc(filepath.Join(t.TempDir(), "nope"), 30, 1<<30)
		newTestModule(t).PruneCache()
	})
	t.Run("old folders go, recent ones stay", func(t *testing.T) {
		root := t.TempDir()
		old := cacheFolder(t, root, "old", 10, 31*day)
		recent := cacheFolder(t, root, "recent", 10, 29*day)
		pruneSrc(root, 30, 1<<30)
		if exists(old) || !exists(recent) {
			t.Errorf("old exists=%v, recent exists=%v", exists(old), exists(recent))
		}
	})
	t.Run("above the limit the oldest go first", func(t *testing.T) {
		root := t.TempDir()
		a := cacheFolder(t, root, "a", 400, 5*day)
		b := cacheFolder(t, root, "b", 400, 3*day)
		c := cacheFolder(t, root, "c", 400, 1*day)
		pruneSrc(root, 30, 900)
		if exists(a) || !exists(b) || !exists(c) {
			t.Errorf("a=%v b=%v c=%v", exists(a), exists(b), exists(c))
		}
		pruneSrc(root, 30, 100)
		if exists(b) || exists(c) {
			t.Error("everything is over the limit")
		}
	})
	t.Run("files in the root are left alone", func(t *testing.T) {
		root := t.TempDir()
		f := filepath.Join(root, "stray.txt")
		_ = os.WriteFile(f, []byte("x"), 0o644)
		pruneSrc(root, 30, 0)
		if !exists(f) {
			t.Error("stray file removed")
		}
	})
	t.Run("using a stream touches its folder", func(t *testing.T) {
		m := newTestModule(t)
		ff := installFakes(t)
		_ = ff
		src := srcFile(t, "a.mov")
		var rec recorder
		job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
		es, err := m.EnsureStream(t.Context(), job, src, 540, 30, nil)
		if err != nil {
			t.Fatal(err)
		}
		dir := filepath.Dir(es.Stream)
		old := time.Now().Add(-40 * day)
		_ = os.Chtimes(dir, old, old)
		if m.StreamFor(src, 540, 30) == nil {
			t.Fatal("stream vanished")
		}
		m.PruneCache()
		if !exists(es.Stream) {
			t.Error("a stream that was just used must survive pruning")
		}
	})
}
