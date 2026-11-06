package proc

import "context"

// LaunchSpec describes a program Toolbox opens for the user (Open in app,
// SPEC.md §4.2). Unlike Run, a launched program is detached and visible, and
// it is never killed when the caller's context ends: Launch is the one
// exception to this package's tree-kill rule.
type LaunchSpec struct {
	Path      string   // absolute .exe (Windows) or .app bundle (macOS)
	Args      []string // passed as separate arguments; never through a shell
	Dir       string   // "" = the program's own folder
	Minimized bool     // start minimized / in the background
}

// Launched identifies a started program. PID is 0 when the OS doesn't say
// (macOS `open`).
type Launched struct {
	PID     uint32
	Created int64 // creation time, Unix ms (0 with PID 0)
}

// ExitedEarlyError is returned when the program exited with a non-zero code
// within the first 2 s.
type ExitedEarlyError struct{ Code int }

func (e *ExitedEarlyError) Error() string { return "the program exited at once" }

// Launch starts s and returns once it is running (waiting up to 2 s to catch
// an immediate non-zero exit; an exit 0 is a single-instance hand-off and
// succeeds). ctx bounds only that wait.
func Launch(ctx context.Context, s LaunchSpec) (Launched, error) { return launch(ctx, s) }
