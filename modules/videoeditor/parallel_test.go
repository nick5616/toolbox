package videoeditor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core/media"
)

func TestProbeFilesKeepsOrderInParallel(t *testing.T) {
	dir := t.TempDir()
	var paths []string
	for i := 0; i < 25; i++ {
		p := filepath.Join(dir, fmt.Sprintf("v%02d.mp4", i))
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}
	old := probeMedia
	defer func() { probeMedia = old }()
	var cur, peak atomic.Int32
	probeMedia = func(_ context.Context, _ string, path string) (media.Info, error) {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		defer cur.Add(-1)
		var idx int
		_, _ = fmt.Sscanf(filepath.Base(path), "v%d.mp4", &idx)
		time.Sleep(time.Duration(25-idx) * time.Millisecond) // later files finish first
		return media.Info{DurationMs: int64(idx) * 1000, Video: &media.VideoStream{Width: 10, Height: 10, FPS: 30}}, nil
	}
	got := ProbeFiles(context.Background(), "ffprobe", paths)
	for i, g := range got {
		if g.Path != paths[i] || g.DurationMs != int64(i)*1000 {
			t.Fatalf("row %d = %+v", i, g)
		}
	}
	if peak.Load() > probeParallel {
		t.Errorf("peak concurrency %d above the limit", peak.Load())
	}
	// A cancelled context still returns a row per path.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i, g := range ProbeFiles(ctx, "ffprobe", paths) {
		if g.Path != paths[i] || g.Error == "" {
			t.Fatalf("cancelled row %d = %+v", i, g)
		}
	}
}
