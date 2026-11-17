package heic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core/sidecar"
)

// fakeEngine stands in for image.convert: it writes a PNG-ish file, counts
// concurrent calls and per-file calls, and can block.
type fakeEngine struct {
	cur, peak atomic.Int32
	calls     sync.Map // input -> *atomic.Int32
	gate      chan struct{}
}

func (f *fakeEngine) Call(ctx context.Context, _ string, params any, _ func(sidecar.Event)) (json.RawMessage, error) {
	p := params.(map[string]any)
	n := f.cur.Add(1)
	defer f.cur.Add(-1)
	for {
		pk := f.peak.Load()
		if n <= pk || f.peak.CompareAndSwap(pk, n) {
			break
		}
	}
	c, _ := f.calls.LoadOrStore(p["input"], new(atomic.Int32))
	c.(*atomic.Int32).Add(1)
	select {
	case <-f.gate:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return nil, os.WriteFile(p["output"].(string), []byte("png"), 0o644)
}

// onlyEngine makes the FFmpeg path fail at once so conversions use the engine.
func onlyEngine(id string) (string, error) {
	if id == sidecar.DepID {
		return "engine", nil
	}
	return "", os.ErrNotExist
}

func writeFiles(t *testing.T, n int) []string {
	t.Helper()
	dir := t.TempDir()
	var out []string
	for i := range n {
		p := filepath.Join(dir, fmt.Sprintf("p%d.heic", i))
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func TestConversionsAreBounded(t *testing.T) {
	eng := &fakeEngine{gate: make(chan struct{})}
	d := &Decoder{CacheDir: t.TempDir(), Resolve: onlyEngine, Engine: eng}
	files := writeFiles(t, 12)
	var wg sync.WaitGroup
	for _, f := range files {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := d.ToPNG(context.Background(), f); err != nil {
				t.Error(err)
			}
		}()
	}
	limit := int32(maxConversions())
	deadline := time.Now().Add(5 * time.Second)
	for eng.cur.Load() < limit && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond) // give extras a chance to (wrongly) start
	if got := eng.cur.Load(); got != limit {
		t.Fatalf("running = %d, want %d", got, limit)
	}
	close(eng.gate)
	wg.Wait()
	if eng.peak.Load() > limit {
		t.Fatalf("peak = %d, limit %d", eng.peak.Load(), limit)
	}
}

func TestSameFileSharesOneConversion(t *testing.T) {
	eng := &fakeEngine{gate: make(chan struct{})}
	d := &Decoder{CacheDir: t.TempDir(), Resolve: onlyEngine, Engine: eng}
	f := writeFiles(t, 1)[0]
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := d.ToPNG(context.Background(), f); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(eng.gate)
	wg.Wait()
	c, _ := eng.calls.Load(f)
	if n := c.(*atomic.Int32).Load(); n != 1 {
		t.Fatalf("engine calls = %d, want 1", n)
	}
}

func TestWaitingForASlotHonoursContext(t *testing.T) {
	eng := &fakeEngine{gate: make(chan struct{})}
	var wg sync.WaitGroup
	defer wg.Wait()
	defer close(eng.gate)
	d := &Decoder{CacheDir: t.TempDir(), Resolve: onlyEngine, Engine: eng}
	files := writeFiles(t, maxConversions()+1)
	for _, f := range files[:maxConversions()] {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = d.ToPNG(context.Background(), f) }()
	}
	for eng.cur.Load() < int32(maxConversions()) {
		time.Sleep(5 * time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := d.ToPNG(ctx, files[maxConversions()]); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want deadline exceeded", err)
	}
}
