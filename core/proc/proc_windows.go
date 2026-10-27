//go:build windows

package proc

import (
	"os/exec"
	"strconv"
	"syscall"
)

// createNoWindow is CREATE_NO_WINDOW (not exported by package syscall).
const createNoWindow = 0x08000000

func hidden() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
	}
}

func configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = hidden()
}

// killTree force-kills the process and all its descendants.
func killTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	kill.SysProcAttr = hidden()
	if err := kill.Run(); err != nil {
		// The tree may already be gone; fall back to killing the direct child.
		return cmd.Process.Kill()
	}
	return nil
}
