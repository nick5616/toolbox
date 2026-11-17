package imaging

import (
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The disk cache keeps built previews across restarts (<support>/cache/thumbs).
// A file holds one data URL; its name is a hash of the source's identity
// (path, size, mtime) and the size asked for. Reading one back costs well
// under a millisecond, building it 50 ms to a second.

const (
	// diskVersion changes the names of every cached preview when the way
	// previews are built changes.
	diskVersion  = "1"
	diskExt      = ".dataurl"
	diskMaxAge   = 30 * 24 * time.Hour
	diskMaxBytes = 1 << 30
)

// SetCacheDir keeps the process-wide Thumbnailer's previews in dir as well.
func SetCacheDir(dir string) { Default().SetDiskCache(dir) }

// PruneCache trims the process-wide Thumbnailer's disk cache (start-up).
func PruneCache() { Default().PruneDisk() }

// SetDiskCache keeps built previews in dir too ("" turns it off).
func (t *Thumbnailer) SetDiskCache(dir string) {
	t.mu.Lock()
	t.dir = dir
	t.mu.Unlock()
}

func (t *Thumbnailer) diskPath(key string) string {
	t.mu.Lock()
	dir := t.dir
	t.mu.Unlock()
	if dir == "" {
		return ""
	}
	h := sha1.Sum([]byte(diskVersion + "|" + key))
	return filepath.Join(dir, hex.EncodeToString(h[:])+diskExt)
}

func (t *Thumbnailer) readDisk(key string) (string, bool) {
	p := t.diskPath(key)
	if p == "" {
		return "", false
	}
	b, err := os.ReadFile(p)
	if err != nil || !bytes.HasPrefix(b, []byte("data:image/")) {
		return "", false
	}
	// Recently used previews are pruned last.
	now := time.Now()
	_ = os.Chtimes(p, now, now)
	return string(b), true
}

func (t *Thumbnailer) writeDisk(key, url string) {
	p := t.diskPath(key)
	if p == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		slog.Warn("thumb cache: mkdir", "err", err)
		return
	}
	var r [4]byte
	_, _ = rand.Read(r[:])
	tmp := p + ".part-" + hex.EncodeToString(r[:])
	if err := os.WriteFile(tmp, []byte(url), 0o644); err != nil {
		_ = os.Remove(tmp)
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
	}
}

// PruneDisk deletes cached previews unused for 30 days, then the least
// recently used ones until the cache is under 1 GB, and stray partial files.
func (t *Thumbnailer) PruneDisk() {
	t.mu.Lock()
	dir := t.dir
	t.mu.Unlock()
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
	now := time.Now()
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		p := filepath.Join(dir, e.Name())
		age := now.Sub(info.ModTime())
		if age > diskMaxAge || (strings.Contains(e.Name(), ".part-") && age > time.Hour) {
			_ = os.Remove(p)
			continue
		}
		files = append(files, file{p, info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		if total <= diskMaxBytes {
			break
		}
		if err := os.Remove(f.path); err == nil {
			total -= f.size
		}
	}
}
