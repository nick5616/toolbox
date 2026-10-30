package viz

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// nowFunc is the clock (tests replace it).
var nowFunc = time.Now

const (
	cacheMaxAge   = 30 * 24 * time.Hour
	cacheMaxBytes = 3 << 30
)

// prune deletes analysis folders untouched for 30 days, then the oldest until
// the folders total under 3 GB (SPEC.md §4.3). Loose files in the cache folder
// (previews) are left alone. Lookup and Analyze touch a folder when they use it.
func (a *Analyzer) prune() { a.pruneTo(cacheMaxAge, cacheMaxBytes) }

func (a *Analyzer) pruneTo(maxAge time.Duration, maxBytes int64) {
	entries, err := os.ReadDir(a.cacheDir)
	if err != nil {
		return
	}
	type folder struct {
		path string
		mod  time.Time
		size int64
	}
	var keep []folder
	var total int64
	now := nowFunc()
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(a.cacheDir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > maxAge {
			_ = os.RemoveAll(p)
			continue
		}
		var size int64
		_ = filepath.WalkDir(p, func(_ string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				if fi, err := d.Info(); err == nil {
					size += fi.Size()
				}
			}
			return nil
		})
		keep = append(keep, folder{p, info.ModTime(), size})
		total += size
	}
	sort.Slice(keep, func(i, j int) bool { return keep[i].mod.Before(keep[j].mod) })
	for _, f := range keep {
		if total < maxBytes {
			break
		}
		if os.RemoveAll(f.path) == nil {
			total -= f.size
		}
	}
}
