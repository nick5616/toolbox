package media

// CONTRACT STUB (foundation): the exported names are frozen; MD1 implements
// the bodies (SPEC.md §3.4) and the cache helpers in cache.go.

import (
	"context"
	"encoding/json"
	"path/filepath"

	"toolbox/core"
)

// ProxyModuleID is the hidden module that makes preview copies.
const ProxyModuleID = "media-proxy"

// CacheLimitBytes caps <support>/cache/media (preview copies, filmstrips,
// waveforms, frames); the oldest files go first.
const CacheLimitBytes int64 = 5_000_000_000

// CacheDir returns <support>/cache/media.
func CacheDir(p core.Paths) string { return filepath.Join(p.CacheDir, "media") }

// ProxyModule turns a file the webview can't play into a 720p H.264/AAC
// preview copy in <cache>/media/proxy/ (or an AAC .m4a for audio).
type ProxyModule struct {
	cacheDir string
}

// RegisterProxy adds the preview-copy module. cacheDir is CacheDir(paths).
func RegisterProxy(reg *core.Registry, cacheDir string) (*ProxyModule, error) {
	m := &ProxyModule{cacheDir: cacheDir}
	return m, reg.Register(m)
}

// Descriptor implements core.Module.
func (m *ProxyModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ProxyModuleID, Name: "Preview copy", Tagline: "Makes a playable preview copy",
		Icon: "film", Category: core.CategoryMedia, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 2, MaxInputs: 1,
		Requires: []string{"ffmpeg", "ffprobe"},
	}
}

// Validate implements core.Module: exactly one existing input.
func (m *ProxyModule) Validate(inputs []string, _ json.RawMessage) error {
	if len(inputs) != 1 {
		return core.ValidationError("A preview copy takes one file", nil)
	}
	return nil
}

// Run implements core.Module.
func (m *ProxyModule) Run(ctx context.Context, job *core.JobContext) error {
	return m.run(ctx, job)
}

// ProxyPath is where the preview copy of a file with this identity lives
// (it may not exist yet): <cacheDir>/proxy/<sha1(path|size|mtime)>.<ext>,
// .mp4 for video and .m4a for audio-only files.
func ProxyPath(cacheDir, path string, size, mtimeNs int64, audioOnly bool) string {
	return proxyPath(cacheDir, path, size, mtimeNs, audioOnly)
}

// PruneCache deletes the oldest files under cacheDir until the total is
// under limit. Errors are logged, never returned.
func PruneCache(cacheDir string, limit int64) { pruneCache(cacheDir, limit) }
