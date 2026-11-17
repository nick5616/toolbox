package deps

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core"
)

func cacheSvc(t *testing.T, root, known, cacheFile string) *Service {
	t.Helper()
	s := newSvc(t, filepath.Join(root, "bin"), nil, known)
	s.SetCacheFile(cacheFile)
	return s
}

func TestDetectionCache(t *testing.T) {
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 7.0 x")
	root := t.TempDir()
	known := filepath.Join(root, "known")
	tool := fakeTool(t, known, "ffmpeg")
	cf := filepath.Join(root, "deps-cache.json")

	s := cacheSvc(t, root, known, cf)
	s.Refresh(context.Background())
	st, ok := s.Known(FFmpeg)
	if !ok || st.State != core.DepOK || st.Version != "7.0" {
		t.Fatalf("first detection: %+v %v", st, ok)
	}
	if _, err := os.Stat(cf); err != nil {
		t.Fatalf("cache file not written: %v", err)
	}

	// A new service loads the file: the status is known before anything runs.
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 9.9 x")
	s2 := cacheSvc(t, root, known, cf)
	if st, ok := s2.Known(FFmpeg); !ok || st.Version != "7.0" || st.State != core.DepOK {
		t.Fatalf("seeded status: %+v %v", st, ok)
	}
	// Hit: the file is unchanged, so the (now different) tool isn't run.
	s2.Refresh(context.Background())
	if st, _ := s2.Known(FFmpeg); st.Version != "7.0" {
		t.Fatalf("cache hit re-ran the tool: %+v", st)
	}
	// Recheck (Detect) ignores the cache.
	s2.Detect(context.Background())
	if st, _ := s2.Known(FFmpeg); st.Version != "9.9" {
		t.Fatalf("Detect must force: %+v", st)
	}

	// Miss: the modification time changed, so Refresh runs the tool again.
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 8.1 x")
	s3 := cacheSvc(t, root, known, cf)
	later := time.Now().Add(-time.Hour)
	if err := os.Chtimes(tool, later, later); err != nil {
		t.Fatal(err)
	}
	s3.Refresh(context.Background())
	if st, _ := s3.Known(FFmpeg); st.Version != "8.1" {
		t.Fatalf("mtime change must miss: %+v", st)
	}
}

func TestDetectionCacheIgnoresCorruptAndStale(t *testing.T) {
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 7.0 x")
	root := t.TempDir()
	known := filepath.Join(root, "known")
	tool := fakeTool(t, known, "ffmpeg")
	cf := filepath.Join(root, "deps-cache.json")

	for name, content := range map[string]string{"corrupt": "{not json", "wrong version": `{"version":99,"entries":{}}`} {
		if err := os.WriteFile(cf, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		s := cacheSvc(t, root, known, cf)
		if _, ok := s.Known(FFmpeg); ok {
			t.Fatalf("%s: seeded from a bad file", name)
		}
		s.Refresh(context.Background())
		if st, ok := s.Known(FFmpeg); !ok || st.State != core.DepOK {
			t.Fatalf("%s: detection after a bad file: %+v", name, st)
		}
	}

	// A stored binary that no longer exists isn't seeded.
	s := cacheSvc(t, root, known, cf)
	s.Refresh(context.Background())
	if err := os.Remove(tool); err != nil {
		t.Fatal(err)
	}
	s2 := cacheSvc(t, root, known, cf)
	if _, ok := s2.Known(FFmpeg); ok {
		t.Fatal("seeded a status whose binary is gone")
	}
}

func TestKnownNeverRuns(t *testing.T) {
	root := t.TempDir()
	s := newSvc(t, filepath.Join(root, "bin"), nil)
	if _, ok := s.Known(YtDlp); ok {
		t.Fatal("undetected dependency reported as known")
	}
	s.Detect(context.Background())
	if st, ok := s.Known(YtDlp); !ok || st.State != core.DepMissing {
		t.Fatalf("after Detect: %+v %v", st, ok)
	}
}

func TestOnChangeOnlyWhenStatusChanges(t *testing.T) {
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 7.0 x")
	root := t.TempDir()
	known := filepath.Join(root, "known")
	fakeTool(t, known, "ffmpeg")
	s := newSvc(t, filepath.Join(root, "bin"), nil, known)
	var n atomic.Int32
	s.OnChange(func() { n.Add(1) })
	s.Refresh(context.Background())
	if n.Load() != 1 {
		t.Fatalf("first detection: %d notifications", n.Load())
	}
	s.Refresh(context.Background())
	if n.Load() != 1 {
		t.Fatalf("unchanged detection notified: %d", n.Load())
	}
}

func TestCheckSharedSingleFlight(t *testing.T) {
	root := t.TempDir()
	s := newSvc(t, filepath.Join(root, "bin"), nil)
	var runs atomic.Int32
	release := make(chan struct{})
	s.RegisterVirtual(Spec{ID: "slow", Name: "Slow"}, func(context.Context) core.DepStatus {
		runs.Add(1)
		<-release
		return core.DepStatus{ID: "slow", State: core.DepOK, Path: "/x"}
	})
	e, _ := s.entry("slow")
	done := make(chan core.DepStatus, 2)
	go func() { done <- s.checkShared(context.Background(), e, false) }()
	for runs.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	go func() { done <- s.checkShared(context.Background(), e, false) }()
	time.Sleep(30 * time.Millisecond)
	close(release)
	for i := 0; i < 2; i++ {
		if st := <-done; st.State != core.DepOK {
			t.Fatalf("status %+v", st)
		}
	}
	if runs.Load() != 1 {
		t.Fatalf("detect ran %d times, want 1", runs.Load())
	}
}
