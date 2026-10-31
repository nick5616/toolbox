//go:build windows

package pipeline

import "syscall"

// hiddenAttr reports the Windows hidden attribute.
func hiddenAttr(path string) bool {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	a, err := syscall.GetFileAttributes(p)
	if err != nil {
		return false
	}
	return a&syscall.FILE_ATTRIBUTE_HIDDEN != 0
}
