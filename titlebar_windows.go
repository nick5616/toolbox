//go:build windows

package main

import (
	"log/slog"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// dwmwaUseImmersiveDarkMode is DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 20H1+).
const dwmwaUseImmersiveDarkMode = 20

var procDwmSetWindowAttribute = syscall.NewLazyDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")

// setTitleBarDark switches the native title bar between dark and light.
func setTitleBarDark(w *application.WebviewWindow, dark bool) {
	hwnd := w.NativeWindow()
	if hwnd == nil {
		return
	}
	var v int32
	if dark {
		v = 1
	}
	if err := procDwmSetWindowAttribute.Find(); err != nil {
		slog.Warn("title bar theme unavailable", "err", err)
		return
	}
	r, _, _ := procDwmSetWindowAttribute.Call(uintptr(hwnd), dwmwaUseImmersiveDarkMode, uintptr(unsafe.Pointer(&v)), unsafe.Sizeof(v))
	if r != 0 {
		slog.Warn("set title bar theme", "hresult", r)
	}
}
