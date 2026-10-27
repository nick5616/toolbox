//go:build !windows

package proc

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

func configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killTree sends SIGTERM to the process group, then SIGKILL after killGrace.
func killTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	pgid := -cmd.Process.Pid
	err := syscall.Kill(pgid, syscall.SIGTERM)
	time.AfterFunc(killGrace, func() { _ = syscall.Kill(pgid, syscall.SIGKILL) })
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
