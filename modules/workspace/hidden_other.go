//go:build !windows

package workspace

import (
	"io/fs"
	"strings"
)

// skipEntry reports whether the walker must skip an entry: hidden files and
// folders, symlinks and other non-regular, non-directory entries.
func skipEntry(_ string, d fs.DirEntry) bool {
	if strings.HasPrefix(d.Name(), ".") {
		return true
	}
	return d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0
}
