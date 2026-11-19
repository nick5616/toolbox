//go:build windows

package mediaindex

import (
	"context"
	"path/filepath"
	"syscall"
	"testing"
)

// The Windows hidden and system attributes keep files and folders out of the walk.
func TestWalkSkipsWindowsHiddenAndSystem(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "visible.jpg"), 1)
	touch(t, filepath.Join(root, "hidden.jpg"), 1)
	touch(t, filepath.Join(root, "system.jpg"), 1)
	touch(t, filepath.Join(root, "hiddendir", "x.jpg"), 1)
	set := func(p string, attr uint32) {
		ptr, _ := syscall.UTF16PtrFromString(p)
		if err := syscall.SetFileAttributes(ptr, attr); err != nil {
			t.Fatal(err)
		}
	}
	set(filepath.Join(root, "hidden.jpg"), syscall.FILE_ATTRIBUTE_HIDDEN)
	set(filepath.Join(root, "system.jpg"), syscall.FILE_ATTRIBUTE_SYSTEM)
	set(filepath.Join(root, "hiddendir"), syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_DIRECTORY)
	cs, err := newScanRules(root, nil, nil).walk(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	items, err := statCandidates(context.Background(), cs, "library", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || filepath.Base(items[0].Path) != "visible.jpg" {
		t.Fatalf("items: %+v", items)
	}
}
