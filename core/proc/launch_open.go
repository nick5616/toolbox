package proc

import "time"

// macOpenArgs builds the arguments of macOS `open` for a .app bundle:
// `open -a <App> [-g] [--args …]` (SPEC.md §1.7). Pure, so it is tested on
// every OS.
func macOpenArgs(s LaunchSpec) []string {
	a := []string{"-a", s.Path}
	if s.Minimized {
		a = append(a, "-g")
	}
	if len(s.Args) > 0 {
		a = append(a, "--args")
		a = append(a, s.Args...)
	}
	return a
}

// earlyExitWindow is how long Launch waits to catch an immediate failure.
const earlyExitWindow = 2 * time.Second
