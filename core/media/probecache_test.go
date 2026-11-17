package media

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGroupSharesOneCall(t *testing.T) {
	var g group[string, int]
	var runs atomic.Int32
	gate := make(chan struct{})
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := g.do(context.Background(), "k", func() (int, error) {
				runs.Add(1)
				<-gate
				return 7, nil
			})
			if v != 7 || err != nil {
				t.Errorf("got %d %v", v, err)
			}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(gate)
	wg.Wait()
	if runs.Load() != 1 {
		t.Fatalf("fn ran %d times", runs.Load())
	}
}

func TestGroupWaiterRetriesWhenLeaderCancelled(t *testing.T) {
	var g group[string, int]
	leaderCtx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	go func() {
		_, _ = g.do(leaderCtx, "k", func() (int, error) {
			close(started)
			<-leaderCtx.Done()
			return 0, leaderCtx.Err()
		})
	}()
	<-started
	res := make(chan int, 1)
	go func() {
		v, _ := g.do(context.Background(), "k", func() (int, error) { return 42, nil })
		res <- v
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case v := <-res:
		if v != 42 {
			t.Fatalf("v = %d", v)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter never ran its own call")
	}
}

func TestGroupWaiterHonoursOwnContext(t *testing.T) {
	var g group[string, int]
	gate := make(chan struct{})
	defer close(gate)
	go func() { _, _ = g.do(context.Background(), "k", func() (int, error) { <-gate; return 1, nil }) }()
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := g.do(ctx, "k", func() (int, error) { return 2, nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

func TestProbeReturnsCopies(t *testing.T) {
	f := filepath.Join(t.TempDir(), "c.mp4")
	if err := os.WriteFile(f, []byte("copy"), 0o644); err != nil {
		t.Fatal(err)
	}
	exe := fakeProbe(t, string(fixture(t, "plain")), false)
	a, err := Probe(context.Background(), exe, f)
	if err != nil || len(a.Audio) == 0 {
		t.Fatalf("probe: %v %+v", err, a)
	}
	a.Audio[0].Codec = "mutated"
	a.Video.Width = -1
	if a.Tags != nil {
		a.Tags["x"] = "y"
	}
	b, _ := Probe(context.Background(), exe, f)
	if b.Audio[0].Codec == "mutated" || b.Video.Width == -1 || b.Tags["x"] != "" {
		t.Fatalf("cache entry was mutated through a returned Info: %+v", b)
	}
}

func resetProbeCache() {
	cacheMu.Lock()
	cache = map[cacheKey]Info{}
	cacheOrder = nil
	cacheMu.Unlock()
}

func TestProbeAndKeyframesPersistToDisk(t *testing.T) {
	dir := t.TempDir()
	SetCacheDir(filepath.Join(dir, "cache"))
	t.Cleanup(func() { SetCacheDir("") })
	f := filepath.Join(dir, "d.mp4")
	if err := os.WriteFile(f, []byte("disk"), 0o644); err != nil {
		t.Fatal(err)
	}
	exe := fakeProbe(t, string(fixture(t, "plain")), false)
	resetProbeCache()
	want, err := Probe(context.Background(), exe, f)
	if err != nil {
		t.Fatal(err)
	}
	// A restart: memory empty, ffprobe broken; the disk copy answers.
	resetProbeCache()
	t.Setenv("FAKE_PROBE_FAIL", "1")
	got, err := Probe(context.Background(), exe, f)
	if err != nil || got.DurationMs != want.DurationMs || got.Video == nil {
		t.Fatalf("disk probe: %v %+v", err, got)
	}

	// Keyframes: probed once (the fake prints the probe JSON for -show_entries
	// too, so give it a keyframe list), then served from disk.
	t.Setenv("FAKE_PROBE_FAIL", "")
	t.Setenv("FAKE_PROBE_STDOUT", "2.000000,\n0.000000,\n1.000000\n")
	kf, err := TimelineKeyframes(context.Background(), exe, f)
	if err != nil || len(kf) != 3 {
		t.Fatalf("keyframes: %v %v", err, kf)
	}
	kf[0] = 99 // the caller's copy
	t.Setenv("FAKE_PROBE_FAIL", "1")
	again, err := TimelineKeyframes(context.Background(), exe, f)
	if err != nil || len(again) != 3 || again[0] == 99 {
		t.Fatalf("cached keyframes: %v %v", err, again)
	}
}
