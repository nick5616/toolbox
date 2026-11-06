//go:build !windows

package api

import "os"

// linkAttrs reports whether info (from os.Lstat) is a symlink or other
// irregular link, and whether it is hidden (never, here: dot-names are
// checked by name).
func linkAttrs(info os.FileInfo) (link, hidden bool) {
	return info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0, false
}
