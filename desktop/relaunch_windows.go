//go:build windows

package desktop

import (
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// relaunchCommand starts exe with args directly, detached from this process.
// There's no cmd.exe or sleep in between (those flashed a console window):
// the new process waits for this one itself (--after-pid, WaitForExit).
func relaunchCommand(exe string, args []string) *exec.Cmd {
	cmd := exec.Command(exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
	}
	return cmd
}

// WaitForExit blocks until process pid has exited, or timeout. A PID that
// can't be opened (already gone) returns at once.
func WaitForExit(pid int, timeout time.Duration) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	_, _ = windows.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
}
