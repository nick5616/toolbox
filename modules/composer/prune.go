package composer

import (
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Cache limits for scaled and converted source images (called at start).
const (
	cacheMaxAge   = 30 * 24 * time.Hour
	cacheMaxBytes = 2 << 30
)

// PruneCache deletes cached images unused for 30 days, then the oldest until
// the cache is under 2 GB.
func (m *Module) PruneCache() { pruneDir(m.cfg.CacheDir, time.Now(), cacheMaxAge, cacheMaxBytes) }

func pruneDir(dir string, now time.Time, maxAge time.Duration, maxBytes int64) {
	if dir == "" {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type file struct {
		path string
		size int64
		mod  time.Time
	}
	var files []file
	var total int64
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if now.Sub(info.ModTime()) > maxAge {
			_ = os.Remove(p)
			continue
		}
		files = append(files, file{p, info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		if total <= maxBytes {
			break
		}
		if os.Remove(f.path) == nil {
			total -= f.size
		}
	}
}
