// Package workspace is the hidden job module behind a workspace's baseline:
// seed (copy the baseline into the library), restore (re-copy missing or
// changed baseline files) and tidy (move non-baseline files to the trash).
// Phase 21 SPEC §A4. W1 implements Run.
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

// Config wires the module to the open workspace.
type Config struct {
	Boot  ws.Boot
	Trash trash.Trasher
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
	return core.Errorf(core.CodeInternal, "Workspace jobs aren't ready yet")
}
