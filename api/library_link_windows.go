//go:build windows

package api

import (
	"os"
	"syscall"
)

// isLinkOrHidden reports whether info (from os.Lstat) is a symlink, junction
// or other reparse point, and whether it is hidden.
func linkAttrs(info os.FileInfo) (link, hidden bool) {
	if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		link = true
	}
	if d, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		if d.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			link = true
		}
		if d.FileAttributes&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
			hidden = true
		}
	}
	return link, hidden
}
