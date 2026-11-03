package editstudio

import (
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// The edit-source cache (SPEC.md §7.6, §15). WP-ES4.

// Cache limits.
const (
	CacheMaxAgeDays = 30
	CacheMaxBytes   = int64(10) << 30
)

// now is a seam for tests.
var cacheNow = time.Now

type cacheEntry struct {
	dir  string
	mod  time.Time
	size int64
}

// dirSize adds up the files under dir.
func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n
}

// PruneCache removes cache/editstudio folders unused for 30 days, then the
// oldest until the total is at most 10 GB. Called at start.
func (m *Module) PruneCache() { pruneSrc(m.srcRoot(), CacheMaxAgeDays, CacheMaxBytes) }

// pruneSrc is PruneCache over a root folder with explicit limits.
func pruneSrc(root string, maxAgeDays int, maxBytes int64) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return // no cache yet
	}
	cutoff := cacheNow().Add(-time.Duration(maxAgeDays) * 24 * time.Hour)
	var keep []cacheEntry
	var total int64
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if fi.ModTime().Before(cutoff) {
			if err := os.RemoveAll(dir); err != nil {
				slog.Warn("edit cache prune", "dir", dir, "err", err)
			}
			continue
		}
		size := dirSize(dir)
		total += size
		keep = append(keep, cacheEntry{dir, fi.ModTime(), size})
	}
	if total <= maxBytes {
		return
	}
	slices.SortFunc(keep, func(a, b cacheEntry) int { return a.mod.Compare(b.mod) })
	for _, c := range keep {
		if total <= maxBytes {
			break
		}
		if err := os.RemoveAll(c.dir); err != nil {
			slog.Warn("edit cache prune", "dir", c.dir, "err", err)
			continue
		}
		total -= c.size
	}
}
