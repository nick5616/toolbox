//go:build windows

package lanshare

import (
	"io/fs"
	"syscall"
)

// systemEntry reports whether the entry has the hidden or system attribute.
func systemEntry(path string, _ fs.DirEntry) bool {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attrs, err := syscall.GetFileAttributes(p)
	if err != nil {
		return false
	}
	return attrs&(syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_SYSTEM) != 0
}
