package focus

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	iconSize     = 32
	iconKeepDays = 30
)

// SetCacheDir sets the folder icons are cached in (<support>/cache/focus-icons)
// and prunes files older than 30 days. Without it icons are only kept in
// memory. main.go calls it once.
func (s *Service) SetCacheDir(dir string) {
	s.mu.Lock()
	s.cacheDir = dir
	s.mu.Unlock()
	if dir == "" {
		return
	}
	cutoff := s.clock().Add(-iconKeepDays * 24 * time.Hour)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".png") {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// AppIcon is a program's 32 px icon as a PNG data URL ("" = none). Windows
// only; the Mac shows a lettered tile.
func (s *Service) AppIcon(path string) string {
	if path == "" {
		return ""
	}
	st, err := os.Stat(path)
	if err != nil {
		return ""
	}
	sum := sha1.Sum([]byte(strings.ToLower(path) + "|" + strconv.FormatInt(st.ModTime().UnixNano(), 10)))
	key := hex.EncodeToString(sum[:])

	s.mu.Lock()
	if v, ok := s.icons[key]; ok {
		s.mu.Unlock()
		return v
	}
	dir := s.cacheDir
	render := s.iconFn
	s.mu.Unlock()
	if render == nil {
		render = renderIcon
	}

	var png []byte
	file := ""
	if dir != "" {
		file = filepath.Join(dir, key+".png")
		if b, err := os.ReadFile(file); err == nil && len(b) > 0 {
			png = b
			now := s.clock()
			_ = os.Chtimes(file, now, now) // keep it alive
		}
	}
	if png == nil {
		png, err = render(path)
		if err != nil || len(png) == 0 {
			return ""
		}
		if file != "" {
			if os.MkdirAll(dir, 0o755) == nil {
				_ = os.WriteFile(file, png, 0o644)
			}
		}
	}
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	s.mu.Lock()
	if len(s.icons) > 512 {
		s.icons = map[string]string{}
	}
	s.icons[key] = url
	s.mu.Unlock()
	return url
}
