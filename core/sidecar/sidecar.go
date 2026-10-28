// Package sidecar runs and installs the Python AI engine (SPEC.md §4):
// a uv-managed CPython 3.12 venv in the support dir, spoken to over stdio
// JSON Lines by a lazily started, idle-stopped, crash-restarted process.
//
// Files: manager.go (process + protocol), detect.go (detection, removal,
// models), setup.go (the install/update/repair module).
package sidecar

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// IDs used across the app.
const (
	// DepID is the virtual dependency representing the installed engine.
	DepID = "audio-engine"
	// SetupModuleID is the hidden system module that installs/updates/repairs it.
	SetupModuleID = "system-audio-engine"
)

// Event is a streamed message for one request.
type Event struct {
	Kind  string  // "progress" | "log" | "output"
	Pct   float64 // progress: 0..1, or -1 indeterminate
	Msg   string  // progress message
	Line  string  // log line
	Level string  // log level: info | warning | error
	Path  string  // output path
}

// Caller sends one request to the engine and waits for its result.
// onEvent (may be nil) receives the request's events in order.
type Caller interface {
	Call(ctx context.Context, method string, params any, onEvent func(Event)) (json.RawMessage, error)
}

// Status is a snapshot of the engine process.
type Status struct {
	Running   bool  `json:"running"`
	Pid       int   `json:"pid"`
	RSSBytes  int64 `json:"rssBytes"`
	StartedAt int64 `json:"startedAt"`
}

// PythonPath is the venv interpreter path (whether or not it exists).
func PythonPath(p core.Paths) string { return pythonPath(p) }
