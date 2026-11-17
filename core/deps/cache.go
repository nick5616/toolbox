package deps

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// Persisted detection results. Running `tool --version` is the slow part of
// detection (yt-dlp alone takes ~1.6 s), so the result is kept in
// <support>/deps-cache.json keyed by the binary's path, size and modification
// time (plus the parts of its Spec that shape the result). A start-up
// detection reuses a result whose key still matches; a changed or absent key
// runs the tool. "Recheck" (Detect) ignores the cache. Managed archives that
// read a VERSION file never run anything, so they aren't cached.

const cacheVersion = 1

// cacheEntry is one dependency's persisted result.
type cacheEntry struct {
	Key    string         `json:"key"`
	Status core.DepStatus `json:"status"`
}

type cacheFile struct {
	Version int                   `json:"version"`
	Entries map[string]cacheEntry `json:"entries"`
}

// SetCacheFile enables persistence at path and loads it: every stored binary
// whose file still exists seeds the status cache, so the UI is right at once
// (Refresh re-validates it in the background). A missing or corrupt file is
// ignored.
func (s *Service) SetCacheFile(path string) {
	s.mu.Lock()
	s.cachePath = path
	s.mu.Unlock()
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var f cacheFile
	if json.Unmarshal(b, &f) != nil || f.Version != cacheVersion {
		return
	}
	specs := map[string]Spec{}
	for _, e := range s.entries() {
		if e.detect == nil {
			specs[e.ID] = e.Spec
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, ce := range f.Entries {
		sp, ok := specs[id]
		if !ok || ce.Status.ID != id {
			continue
		}
		if ce.Status.Path != "" && !isFile(ce.Status.Path) {
			continue
		}
		if ce.Key != s.keyFor(sp, ce.Status.Path) {
			continue
		}
		if _, have := s.cache[id]; !have {
			ce.Status.RequiredBy, ce.Status.RecommendedBy = []string{}, []string{}
			s.cache[id] = ce.Status
		}
		s.keyed[id] = ce
	}
}

// keyFor builds the cache key of a detected binary: "" when it can't be
// stat'ed.
func (s *Service) keyFor(sp Spec, path string) string {
	if path == "" {
		return ""
	}
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%s|%d|%d|%s", path, fi.Size(), fi.ModTime().UnixNano(), specFingerprint(sp))
}

func (s *Service) runKey(sp Spec, path string) string { return s.keyFor(sp, path) }

// specFingerprint covers what shapes a version check's outcome.
func specFingerprint(sp Spec) string {
	re := ""
	if sp.VersionRegex != nil {
		re = sp.VersionRegex.String()
	}
	return strings.Join([]string{strings.Join(sp.VersionArgs, " "), re, sp.PinnedVersion, sp.MinVersion, fmt.Sprint(sp.AllowSystem)}, "\x1f")
}

// cachedRun returns the stored result for id when its key matches.
func (s *Service) cachedRun(id, key string) (core.DepStatus, bool) {
	if key == "" {
		return core.DepStatus{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ce, ok := s.keyed[id]
	if !ok || ce.Key != key {
		return core.DepStatus{}, false
	}
	return ce.Status, true
}

// storeRun remembers a result under its key. Errors are never cached (a
// timeout or a locked file may pass).
func (s *Service) storeRun(id, key string, st core.DepStatus) {
	if key == "" || st.State == core.DepError {
		return
	}
	st.RequiredBy, st.RecommendedBy = nil, nil
	s.mu.Lock()
	s.keyed[id] = cacheEntry{Key: key, Status: st}
	s.mu.Unlock()
}

// saveCache writes the cache atomically (best effort).
func (s *Service) saveCache() {
	s.mu.Lock()
	path := s.cachePath
	f := cacheFile{Version: cacheVersion, Entries: make(map[string]cacheEntry, len(s.keyed))}
	for id, ce := range s.keyed {
		f.Entries[id] = ce
	}
	s.mu.Unlock()
	if path == "" {
		return
	}
	b, err := json.Marshal(f)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(path), 0o755) != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) != nil {
		return
	}
	if os.Rename(tmp, path) != nil {
		_ = os.Remove(tmp)
	}
}
