// Package sidecar runs and installs the Python audio engine (SPEC.md §4):
// a uv-managed CPython 3.12 venv in the support dir, spoken to over stdio
// JSON Lines by a lazily started, idle-stopped, crash-restarted process.
//
// CONTRACT STUB (foundation). WP-S1 implements the bodies (manager.go,
// client.go, setup.go, detect.go…); exported names and signatures are frozen.
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

// Manager owns the engine process. It implements Caller.
type Manager struct {
	paths  core.Paths
	python func() (string, error)
	em     core.Emitter
}

var _ Caller = (*Manager)(nil)

// NewManager builds a manager. python resolves the venv interpreter (or
// returns a CodeDependencyMissing error when the engine isn't installed).
func NewManager(p core.Paths, python func() (string, error), em core.Emitter) *Manager {
	return &Manager{paths: p, python: python, em: em}
}

// Call implements Caller, starting the engine on first use.
func (m *Manager) Call(ctx context.Context, method string, params any, onEvent func(Event)) (json.RawMessage, error) {
	if _, err := m.python(); err != nil {
		return nil, err
	}
	return nil, core.NotImplemented("audio engine")
}

// Stop shuts the engine down ($shutdown, then kill after 5 s). Safe to call
// when it isn't running.
func (m *Manager) Stop() error { return nil }

// Status reports the engine process state.
func (m *Manager) Status() Status { return Status{} }

// PythonPath is the venv interpreter path (whether or not it exists).
func PythonPath(p core.Paths) string { return pythonPath(p) }

// Detect reports the installed engine as a dependency status (never starts
// Python): missing / outdated (hash mismatch) / ok.
func Detect(ctx context.Context, p core.Paths) core.DepStatus {
	return core.DepStatus{ID: DepID, Name: "Audio engine", State: core.DepMissing}
}

// RegisterSetup registers the hidden install/update/repair module.
// resolveUV resolves the uv binary; installUV installs it into the managed
// bin dir (used when resolveUV fails); detect re-runs dependency detection.
func RegisterSetup(reg *core.Registry, p core.Paths, m *Manager, resolveUV func() (string, error), installUV func(ctx context.Context, job *core.JobContext) error, detect func(ctx context.Context)) error {
	return nil
}

// Remove stops the engine and deletes the venv, project and Python installs.
func Remove(p core.Paths, m *Manager) error { return core.NotImplemented("remove audio engine") }

// ModelsUsage is the total size of the models dir in bytes.
func ModelsUsage(p core.Paths) (int64, error) { return 0, nil }

// ClearModels deletes everything inside the models dir.
func ClearModels(p core.Paths) error { return core.NotImplemented("clear models") }
