//go:build windows

package desktop

import "syscall"

var procGetSystemMetrics = syscall.NewLazyDLL("user32.dll").NewProc("GetSystemMetrics")

const smShuttingDown = 0x2000

// osShuttingDown is true while Windows is shutting down or signing out
// (SM_SHUTTINGDOWN), when quitting must never be refused.
func osShuttingDown() bool {
	r, _, _ := procGetSystemMetrics.Call(smShuttingDown)
	return r != 0
}
