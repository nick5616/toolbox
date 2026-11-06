//go:build windows

package focus

import (
	"runtime"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Two invisible STATIC popups, one owning the other: only the unowned one may
// ever receive WM_CLOSE (SPEC §1.2).
func TestIsOwned(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	create := windows.NewLazySystemDLL("user32.dll").NewProc("CreateWindowExW")
	destroy := windows.NewLazySystemDLL("user32.dll").NewProc("DestroyWindow")
	class, _ := syscall.UTF16PtrFromString("STATIC")
	const wsPopup = 0x80000000
	mk := func(owner uintptr) windows.HWND {
		h, _, _ := create.Call(0, uintptr(unsafe.Pointer(class)), 0, wsPopup, 0, 0, 10, 10, owner, 0, 0, 0)
		return windows.HWND(h)
	}
	a := mk(0)
	if a == 0 {
		t.Skip("cannot create a window here")
	}
	defer destroy.Call(uintptr(a))
	b := mk(uintptr(a))
	if b == 0 {
		t.Fatal("owned window not created")
	}
	defer destroy.Call(uintptr(b))
	if isOwned(a) {
		t.Fatal("unowned window reported as owned")
	}
	if !isOwned(b) {
		t.Fatal("owned window reported as unowned")
	}
}
