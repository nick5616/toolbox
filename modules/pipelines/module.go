// Package pipelines is the Pipelines module: the page's service and the
// built-in steps (rename, chat, table, zip, copy) that run as its jobs
// (SPEC.md §7, §9.3). The runner itself is core/pipeline.
//
// CONTRACT STUB (Wave 0): options.go, the descriptor, Register's signature
// and service.go are final. WP-BI1 implements Validate/Run, the adapters in
// steps.go and the templates.
package pipelines

import (
	"context"
	"encoding/json"

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
}

// Config wires the module.
type Config struct {
	Runner     *pipeline.Runner
	Chat       core.TextGenerator
	Outputs    core.OutputStore
	Emitter    core.Emitter
	LibraryDir func() string
}

// Register adds the module and the built-in step types to the registry and
// the runner.
func Register(reg *core.Registry, cfg Config) (*Module, error) {
	m := &Module{tg: cfg.Chat, outputs: cfg.Outputs, em: cfg.Emitter, libraryDir: cfg.LibraryDir}
	if err := reg.Register(m); err != nil {
		return nil, err
	}
	for _, b := range m.builtins() {
		if err := cfg.Runner.RegisterBuiltin(b.t, b.a); err != nil {
			return nil, err
		}
	}
	return m, nil
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

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return core.NotImplemented("Pipeline steps") // WP-BI1
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("Pipeline steps") // WP-BI1
}
