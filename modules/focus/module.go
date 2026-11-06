// Package focus is the Focus Lock module (SPEC.md, Phase 18): the tool's
// service and the Focus pipeline step. The engine is core/focus.
package focus

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// ModuleID is Focus Lock's module ID.
const ModuleID = "focus"

// Module implements core.Module (start/end jobs) and core.Chainable.
type Module struct {
	eng  Engine
	wake func() // Runner.WakeTimeWaits; optional
}

// Register adds the module. wake is called after a step changes the session.
func Register(reg *core.Registry, eng Engine, wake func()) (*Module, error) {
	m := &Module{eng: eng, wake: wake}
	return m, reg.Register(m)
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Focus Lock", Icon: "focus", Category: core.CategoryUtility,
		Tagline:     "Only the apps you need, for as long as you choose",
		Description: "Pick a profile and a length: everything else is stopped when it starts, until the time is up. Your allowed apps, what they start, the operating system and Toolbox keep running.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: []string{}},
		Requires:    []string{},
		Order:       235, Immediate: true,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[JobOptions](options)
	return err
}

// Run implements core.Module. Wave 0 stub; WP-F2 implements it.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("Focus Lock")
}
