// Package workspace is the hidden job module behind a workspace's baseline:
// seed (copy the baseline into the library), restore (re-copy missing or
// changed baseline files) and tidy (move non-baseline files to the trash).
// Phase 21 SPEC §A4. Nothing here ever writes to the baseline; every path is
// checked to be inside <root>/Library, and links are never followed.
package workspace

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/trash"
	ws "toolbox/core/workspace"
)

// ModuleID is the hidden module's ID.
const ModuleID = "workspace"

// Action is what a workspace job does.
type Action string

const (
	ActionSeed    Action = "seed"
	ActionRestore Action = "restore"
	ActionTidy    Action = "tidy"
)

// Options are a workspace job's options. Inputs are empty.
type Options struct {
	Action Action `json:"action"`
}

// Result is a workspace job's result (job.SetResult).
type Result struct {
	Action     Action   `json:"action"`
	Copied     int      `json:"copied"`     // seed/restore: files copied
	Skipped    []string `json:"skipped"`    // seed/restore: files that couldn't be copied (locked), by library path
	Unstripped []string `json:"unstripped"` // seed/restore: photo/video copies that still carry location data
	Trashed    int      `json:"trashed"`    // tidy: files moved to the trash
	Failed     []string `json:"failed"`     // tidy: files that couldn't be moved
	Cleared    int      `json:"cleared"`    // tidy: finished jobs removed from the history
}

// Config wires the module to the open workspace.
type Config struct {
	Boot  ws.Boot
	Trash trash.Trasher
	// Register adds a copied file to the library the way an import does (no job
	// output). Nil: the file becomes an output of the job.
	Register func(path string) error
	// Forget drops the library entries of files that were moved to the trash.
	Forget func(paths []string)
	// ClearHistory removes finished jobs from the history (Jobs.ClearFinished).
	ClearHistory func(ctx context.Context) (int, error)
	// ActiveJobs counts queued and running jobs other than exceptID.
	ActiveJobs func(ctx context.Context, exceptID string) int
	// Strip removes location data from a copy with ExifTool (nil = run it).
	Strip func(ctx context.Context, exe, file string) error
}

// Module implements core.Module.
type Module struct{ cfg Config }

// New makes the module.
func New(cfg Config) *Module { return &Module{cfg: cfg} }

// Register adds the module to reg.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Workspace", Icon: "folder-cog", Category: core.CategoryUtility,
		Status: core.StatusReady, Hidden: true, NotAStep: true, Interactive: true,
		Accepts: core.Accepts{}, Requires: []string{}, Recommends: []string{}, Parts: []string{},
	}
}

// Validate implements core.Module.
func (m *Module) Validate(_ []string, raw json.RawMessage) error {
	var o Options
	if err := json.Unmarshal(raw, &o); err != nil {
		return core.ValidationError("Bad workspace job options", nil)
	}
	switch o.Action {
	case ActionSeed, ActionRestore, ActionTidy:
		return nil
	}
	return core.ValidationError("Unknown workspace action", map[string]string{"action": string(o.Action)})
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	info := m.cfg.Boot.Info
	if info.Root == "" || info.Kind == ws.KindPersonal {
		return core.ValidationError("Personal has no baseline", nil)
	}
	switch o.Action {
	case ActionSeed, ActionRestore:
		return m.copyBaseline(ctx, job, o.Action)
	case ActionTidy:
		return m.tidy(ctx, job)
	}
	return core.ValidationError("Unknown workspace action", nil)
}
