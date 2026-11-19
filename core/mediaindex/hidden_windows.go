//go:build windows

package mediaindex

import "syscall"

// hasHiddenAttr reports whether the path has the Windows hidden or system
// attribute.
func hasHiddenAttr(path string) bool {
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
