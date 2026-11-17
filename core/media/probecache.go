package media

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// group deduplicates concurrent calls with the same key: one caller runs fn,
// the others wait for its result. A waiter whose own context is still alive
// retries when the leader was cancelled (the leader's cancellation is not the
// waiter's).
type group[K comparable, V any] struct {
	mu sync.Mutex
	m  map[K]*call[V]
}

type call[V any] struct {
	done chan struct{}
	val  V
	err  error
}

func (g *group[K, V]) do(ctx context.Context, key K, fn func() (V, error)) (V, error) {
	for {
		g.mu.Lock()
		if c, ok := g.m[key]; ok {
			g.mu.Unlock()
			select {
			case <-c.done:
			case <-ctx.Done():
				var zero V
				return zero, ctx.Err()
			}
			if c.err != nil && errors.Is(c.err, context.Canceled) && ctx.Err() == nil {
				continue
			}
			return c.val, c.err
		}
		if g.m == nil {
			g.m = map[K]*call[V]{}
		}
		c := &call[V]{done: make(chan struct{})}
		g.m[key] = c
		g.mu.Unlock()

		c.val, c.err = fn()
		g.mu.Lock()
		delete(g.m, key)
		g.mu.Unlock()
		close(c.done)
		return c.val, c.err
	}
}

// cloneInfo copies the slices and maps of an Info so a caller can't change a
// cached entry.
func cloneInfo(i Info) Info {
	if i.Video != nil {
		v := *i.Video
		i.Video = &v
	}
	i.Audio = slices.Clone(i.Audio)
	i.Subtitles = slices.Clone(i.Subtitles)
	if i.Tags != nil {
		t := make(map[string]string, len(i.Tags))
		for k, v := range i.Tags {
			t[k] = v
		}
		i.Tags = t
	}
	return i
}

var (
	diskMu  sync.Mutex
	diskDir string
)

// SetCacheDir enables the on-disk copies of probe results and keyframe lists
// under dir (<support>/cache/media): dir/probe/<key>.json and dir/kf/<key>.json.
// Both are plain cache files, counted and pruned with the rest of the media
// cache. Empty disables it (the default).
func SetCacheDir(dir string) {
	diskMu.Lock()
	diskDir = dir
	diskMu.Unlock()
}

func diskSub(sub string) string {
	diskMu.Lock()
	defer diskMu.Unlock()
	if diskDir == "" {
		return ""
	}
	return filepath.Join(diskDir, sub)
}

func readJSONFile(path string, v any) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

// writeJSONFile writes atomically; failures are ignored (it is only a cache).
func writeJSONFile(path string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	dir := filepath.Dir(path)
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	f, err := os.CreateTemp(dir, "w.part-*")
	if err != nil {
		return
	}
	_, werr := f.Write(b)
	cerr := f.Close()
	if werr != nil || cerr != nil || os.Rename(f.Name(), path) != nil {
		_ = os.Remove(f.Name())
	}
}

var probeFlight group[cacheKey, Info]

// kfFile is the on-disk keyframe list: timeline times (StartMs subtracted).
type kfFile struct {
	Times []int64 `json:"times"`
}

var kfFlight group[cacheKey, []int64]

// TimelineKeyframes is Keyframes with Info.StartMs already subtracted
// (clamped at 0), cached on disk (see SetCacheDir) and deduplicated while in
// flight. The returned slice is the caller's.
func TimelineKeyframes(ctx context.Context, ffprobe, path string) ([]int64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		_, perr := Probe(ctx, ffprobe, path) // the usual "doesn't exist any more" error
		return nil, perr
	}
	key := cacheKey{path, fi.Size(), fi.ModTime().UnixNano()}
	file := ""
	if d := diskSub("kf"); d != "" {
		file = filepath.Join(d, CacheKey(path, key.size, key.mtime)+".json")
		var kf kfFile
		if readJSONFile(file, &kf) && kf.Times != nil {
			return kf.Times, nil
		}
	}
	out, err := kfFlight.do(ctx, key, func() ([]int64, error) {
		info, err := Probe(ctx, ffprobe, path)
		if err != nil {
			return nil, err
		}
		kf, err := Keyframes(ctx, ffprobe, path)
		if err != nil {
			return nil, err
		}
		out := make([]int64, len(kf))
		for i, v := range kf {
			out[i] = max(v-info.StartMs, 0)
		}
		if file != "" {
			writeJSONFile(file, kfFile{Times: out})
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return slices.Clone(out), nil
}
