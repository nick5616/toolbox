//go:build windows

package paste

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procIsWindow                 = user32.NewProc("IsWindow")
	procIsIconic                 = user32.NewProc("IsIconic")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procGetAsyncKeyState         = user32.NewProc("GetAsyncKeyState")
	procSendInput                = user32.NewProc("SendInput")
)

const (
	vkShift   = 0x10
	vkControl = 0x11
	vkMenu    = 0x12 // Alt
	vkLWin    = 0x5B
	vkRWin    = 0x5C
	vkV       = 0x56

	inputKeyboard   = 1
	keyeventfKeyUp  = 0x0002
	swRestore       = 9
	asyncKeyDownBit = 0x8000
)

// input mirrors the 64-bit INPUT struct (40 bytes) for a keyboard event; the
// trailing pad sizes the union to MOUSEINPUT.
type input struct {
	typ         uint32
	_           uint32
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
	_           [8]byte
}

var _ [40 - unsafe.Sizeof(input{})]byte // size must be exactly 40 (64-bit Windows)

type winPlatform struct{}

func newPlatform() Platform { return winPlatform{} }

func (winPlatform) Foreground() (Target, bool) {
	h, _, _ := procGetForegroundWindow.Call()
	if h == 0 {
		return 0, false
	}
	var pid uint32
	procGetWindowThreadProcessID.Call(h, uintptr(unsafe.Pointer(&pid)))
	return Target(h), int(pid) == os.Getpid()
}

func (winPlatform) Alive(t Target) bool {
	r, _, _ := procIsWindow.Call(uintptr(t))
	return r != 0
}

func (winPlatform) Activate(t Target) error {
	if r, _, _ := procIsIconic.Call(uintptr(t)); r != 0 {
		procShowWindow.Call(uintptr(t), swRestore)
	}
	r, _, _ := procSetForegroundWindow.Call(uintptr(t))
	if r == 0 {
		return errors.New("couldn't bring the previous window to the front")
	}
	return nil
}

func (winPlatform) ModifiersHeld() bool {
	for _, vk := range []uintptr{vkControl, vkMenu, vkShift, vkLWin, vkRWin} {
		r, _, _ := procGetAsyncKeyState.Call(vk)
		if r&asyncKeyDownBit != 0 {
			return true
		}
	}
	return false
}

func (winPlatform) SendPaste() error {
	ev := func(vk uint16, flags uint32) input {
		return input{typ: inputKeyboard, wVk: vk, dwFlags: flags}
	}
	seq := []input{
		ev(vkControl, 0), ev(vkV, 0), ev(vkV, keyeventfKeyUp), ev(vkControl, keyeventfKeyUp),
	}
	n, _, err := procSendInput.Call(uintptr(len(seq)), uintptr(unsafe.Pointer(&seq[0])), unsafe.Sizeof(seq[0]))
	if int(n) != len(seq) {
		return errors.New("SendInput failed: " + err.Error())
	}
	return nil
}

func (winPlatform) Permission() string       { return Granted }
func (winPlatform) RequestPermission() error { return nil }
