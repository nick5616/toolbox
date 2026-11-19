//go:build windows

package workspace

import (
	"io/fs"
	"path/filepath"
	"strings"
	"syscall"
)

// skipEntry reports whether the walker must skip an entry: hidden files and
// folders, symlinks, junctions and other reparse points.
func skipEntry(path string, d fs.DirEntry) bool {
	if strings.HasPrefix(d.Name(), ".") {
		return true
	}
	if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
		return true
	}
	p, err := syscall.UTF16PtrFromString(`\\?\` + filepath.Clean(path))
	if err != nil {
		return false
	}
	attrs, err := syscall.GetFileAttributes(p)
	if err != nil {
		return false
	}
	const hidden, system, reparse = 0x2, 0x4, 0x400
	return attrs&(hidden|system|reparse) != 0
}
