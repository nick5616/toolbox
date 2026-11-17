// Package pipelines is the Pipelines module: the page's service and the
// built-in steps (rename, chat, table, zip, copy) that run as its jobs
// (SPEC.md §7, §9.3). The runner itself is core/pipeline.
//
// Validate and Run are in run.go; the step adapters in steps.go.
package pipelines

import (
	"encoding/json"
	"time"

	"toolbox/core"
	"toolbox/core/pipeline"
)

// ModuleID is the Pipelines module's ID.
const ModuleID = "pipelines"

// Module implements core.Module for the built-in steps' jobs.
type Module struct {
	tg         core.TextGenerator
	outputs    core.OutputStore
	em         core.Emitter
	libraryDir func() string
	runner     *pipeline.Runner
	launcher   Launcher      // Phase 18: Open in app ↔ Focus Lock
	subPoll    time.Duration // how often a sub-run is checked; tests shorten it
}

// Config wires the module.
type Config struct {
	Runner     *pipeline.Runner
	Chat       core.TextGenerator
	Outputs    core.OutputStore
	Emitter    core.Emitter
	LibraryDir func() string
	Launcher   Launcher // optional
}

// Register adds the module and the built-in step types to the registry and
// the runner.
func Register(reg *core.Registry, cfg Config) (*Module, error) {
	m := &Module{tg: cfg.Chat, outputs: cfg.Outputs, em: cfg.Emitter, libraryDir: cfg.LibraryDir, runner: cfg.Runner, launcher: cfg.Launcher, subPoll: 500 * time.Millisecond}
	if err := reg.Register(m); err != nil {
		return nil, err
	}
	cfg.Runner.RegisterAlias(TypeChatLegacy, TypeChat)
	for _, b := range m.builtins() {
		if err := cfg.Runner.RegisterBuiltin(b.t, b.a); err != nil {
			return nil, err
		}
	}
	return m, nil
}

// IsInteractive implements core.InteractiveJobs: the quick built-in steps
// (rename, table, run another pipeline, open in app) start ahead of queued
// batch jobs; chat, zip and copy can take long and queue normally.
func (m *Module) IsInteractive(options json.RawMessage) bool {
	var o struct {
		Action Action `json:"action"`
	}
	if json.Unmarshal(options, &o) != nil {
		return false
	}
	switch o.Action {
	case ActionRename, ActionTable, ActionRun, ActionOpen:
		return true
	}
	return false
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Pipelines", Icon: "workflow", Category: core.CategoryUtility,
		Tagline:      "Chain tools into one-click workflows",
		Description:  "Run several tools one after another on the files you drop, with built-in templates.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: []string{}},
		OutputSubdir: "Pipelines", Order: 0,
	}
}
