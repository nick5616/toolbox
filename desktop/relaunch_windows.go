//go:build windows

package desktop

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

// relaunchCommand waits a few seconds (ping as a sleep), then starts exe
// with args through cmd's start, fully detached from this process.
func relaunchCommand(exe string, args []string) *exec.Cmd {
	quoted := []string{syscall.EscapeArg(exe)}
	for _, a := range args {
		quoted = append(quoted, syscall.EscapeArg(a))
	}
	line := fmt.Sprintf(`cmd.exe /D /S /C "ping -n %d 127.0.0.1 >NUL & start "" %s"`,
		relaunchDelaySeconds+1, strings.Join(quoted, " "))
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       line,
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
	return cmd
}
