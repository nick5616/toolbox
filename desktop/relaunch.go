package desktop

import (
	"fmt"
	"os"

	"toolbox/core"
	"toolbox/core/workspace"
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
	return relaunch(os.Args[1:], quit, "Restart the dev server to use the new folder")
}

// RelaunchWith is Relaunch with extra arguments (Phase 21): a --workspace
// among args replaces the one in the current command line, other current
// arguments are kept. Under `wails3 dev` it asks for a dev-server restart
// with TOOLBOX_WORKSPACE instead.
func RelaunchWith(args []string, quit func()) error {
	merged := LaunchArgs(os.Args[1:], args)
	msg := "Restart the dev server to switch workspace"
	if v := workspace.ArgValue(args); v != "" {
		msg = "Restart the dev server with TOOLBOX_WORKSPACE=" + v
	}
	return relaunch(merged, quit, msg)
}

// LaunchArgs merges extra into current: a --workspace in extra replaces the
// current one; every other current argument stays, then extra's follow.
func LaunchArgs(current, extra []string) []string {
	out := current
	if workspace.ArgValue(extra) != "" {
		out = workspace.WithArg(current, "")
	}
	return append(append([]string{}, out...), extra...)
}

func relaunch(args []string, quit func(), devMessage string) error {
	if underDev() {
		return core.ValidationError(devMessage, nil)
	}
	exe, err := os.Executable()
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't restart Toolbox").WithCause(err).
			WithHint("Close and reopen Toolbox to use the new folder")
	}
	cmd := relaunchCommand(exe, args)
	if err := cmd.Start(); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't restart Toolbox").WithCause(fmt.Errorf("start %s: %w", exe, err)).
			WithHint("Close and reopen Toolbox to use the new folder")
	}
	_ = cmd.Process.Release()
	quit()
	return nil
}
