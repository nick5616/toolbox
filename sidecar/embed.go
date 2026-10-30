// Package sidecarfiles embeds the Python audio-engine project so the app can
// write it into the support dir and install it with uv. See SPEC.md §4.
package sidecarfiles

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"sort"
	"sync"
)

// FS holds the project files at their repo-relative paths.
// Explicit globs (not directories) so __init__.py is included and
// __pycache__ never is.
//
//go:embed pyproject.toml uv.lock .python-version toolbox_sidecar/*.py toolbox_sidecar/handlers/*.py toolbox_sidecar/redact/*.py toolbox_sidecar/viz/*.py toolbox_sidecar/viz/*.json
var FS embed.FS

var (
	hashOnce sync.Once
	hash     string
)

// Hash is a stable sha256 over every embedded file (path + content). The
// installed engine records it; a mismatch means the engine is outdated.
func Hash() string {
	hashOnce.Do(func() {
		var paths []string
		_ = fs.WalkDir(FS, ".", func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				paths = append(paths, p)
			}
			return nil
		})
		sort.Strings(paths)
		h := sha256.New()
		for _, p := range paths {
			b, _ := FS.ReadFile(p)
			h.Write([]byte(p))
			h.Write([]byte{0})
			h.Write(b)
			h.Write([]byte{0})
		}
		hash = hex.EncodeToString(h.Sum(nil))
	})
	return hash
}

// Files lists the embedded file paths, sorted.
func Files() []string {
	var paths []string
	_ = fs.WalkDir(FS, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			paths = append(paths, p)
		}
		return nil
	})
	sort.Strings(paths)
	return paths
}
