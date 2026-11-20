//go:build !windows

package desktop

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

// relaunchCommand execs exe with args in its own session, so quitting this
// process doesn't take it along. The new process waits for this one itself
// (--after-pid, WaitForExit).
func relaunchCommand(exe string, args []string) *exec.Cmd {
	cmd := exec.Command(exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd
}

// WaitForExit blocks until process pid has exited, or timeout.
func WaitForExit(pid int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}
