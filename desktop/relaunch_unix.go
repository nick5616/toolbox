//go:build !windows

package desktop

import (
	"fmt"
	"os/exec"
	"syscall"
)

// relaunchCommand waits a few seconds, then execs exe with args, in its own
// session so quitting this process doesn't take it along.
func relaunchCommand(exe string, args []string) *exec.Cmd {
	script := fmt.Sprintf(`sleep %d; exec "$0" "$@"`, relaunchDelaySeconds)
	cmd := exec.Command("sh", append([]string{"-c", script, exe}, args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd
}
