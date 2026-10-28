package desktop

import (
	"fmt"
	"os"

	"toolbox/core"
)

// relaunchDelaySeconds is how long the new process waits, so the quitting
// one has released the single-instance lock.
const relaunchDelaySeconds = 3

// underDev reports whether the app runs under `wails3 dev` (which sets
// FRONTEND_DEVSERVER_URL for the app process); a variable so tests can fake it.
var underDev = func() bool { return os.Getenv("FRONTEND_DEVSERVER_URL") != "" }

// Relaunch starts this executable again with the same arguments, detached
// (it waits a few seconds for this process to release the single-instance
// lock), then calls quit. Under `wails3 dev` it doesn't relaunch and returns
// a validation error instead (SPEC.md §7.3).
func Relaunch(quit func()) error {
	if underDev() {
		return core.ValidationError("Restart the dev server to use the new folder", nil)
	}
	exe, err := os.Executable()
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't restart Toolbox").WithCause(err).
			WithHint("Close and reopen Toolbox to use the new folder")
	}
	cmd := relaunchCommand(exe, os.Args[1:])
	if err := cmd.Start(); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't restart Toolbox").WithCause(fmt.Errorf("start %s: %w", exe, err)).
			WithHint("Close and reopen Toolbox to use the new folder")
	}
	_ = cmd.Process.Release()
	quit()
	return nil
}
