package pipelines

import "toolbox/core/focus"

// Phase 18 built-ins: Wait and Open in app (SPEC.md §3.2, §4.2). Frozen
// Wave 0 contract; the adapters are in wait.go (WP-T1) and open.go (WP-O1).

const (
	TypeWait = "pipelines.wait"
	TypeOpen = "pipelines.open"

	ActionOpen Action = "open"
)

// CodeLaunchFailed: "Couldn't open <app>" (hint "The program may have moved;
// pick it again").
const CodeLaunchFailed = "launch_failed"

// Wait modes.
const (
	WaitFor   = "for"
	WaitUntil = "until"
)

// WaitStep are the Wait step's options.
type WaitStep struct {
	Mode    string `json:"mode"`    // WaitFor | WaitUntil
	Minutes int    `json:"minutes"` // for: 1–1440
	At      string `json:"at"`      // until: "HH:MM" 24 h local
	Note    string `json:"note"`    // ≤ 200, shown on the waiting card
}

// DefaultWait waits 25 minutes.
func DefaultWait() WaitStep { return WaitStep{Mode: WaitFor, Minutes: 25, At: "17:00"} }

// Open in app values.
const (
	OpenFilesNone = "none"
	OpenFilesEach = "each"
	OpenFilesAll  = "all"

	OpenWindowNormal    = "normal"
	OpenWindowMinimized = "minimized"

	CloseNever     = "never"
	CloseFocusEnds = "focusEnds"
	CloseRunEnds   = "runEnds"
)

// OpenStep are Open in app's step options.
type OpenStep struct {
	App       string   `json:"app"`       // absolute .exe (or macOS .app); never a template, never bound
	Label     string   `json:"label"`     // "Ableton Live 12"
	Args      []string `json:"args"`      // ≤ 20; templates ({vars}, {file}); an arg of exactly "{files}" = every file as its own argument
	Files     string   `json:"files"`     // OpenFilesNone | OpenFilesEach | OpenFilesAll
	Window    string   `json:"window"`    // OpenWindowNormal | OpenWindowMinimized
	CloseWhen string   `json:"closeWhen"` // CloseNever | CloseFocusEnds | CloseRunEnds
}

// DefaultOpen opens nothing yet (the app is picked in the editor).
func DefaultOpen() OpenStep {
	return OpenStep{App: "", Label: "", Args: []string{}, Files: OpenFilesNone, Window: OpenWindowNormal, CloseWhen: CloseNever}
}

// OpenJob is the job's options (everything expanded).
type OpenJob struct {
	App       string   `json:"app"`
	Label     string   `json:"label"`
	Args      []string `json:"args"`
	Window    string   `json:"window"`
	CloseWhen string   `json:"closeWhen"`
	RunID     string   `json:"runId"`
}

// Launcher connects Open in app to Focus Lock (main.go wires the engine).
type Launcher struct {
	// NoteLaunch records a launched app in the active focus session.
	NoteLaunch func(path string)
	// Subscribe follows focus state changes (closeWhen focusEnds).
	Subscribe func(fn func(focus.State)) (unsubscribe func())
}
