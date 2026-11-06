// Package clipboard is Clipboard History (Phase 3 SPEC.md §4): an opt-in
// recorder of copied text and images, a store-backed history and the bound
// service used by the tool view and the popup.
//
// CONTRACT STUB (foundation): module.go and service.go are final; WP-CB1
// implements history.go (and adds recorder.go, source.go, tests). Exported
// signatures are frozen.
package clipboard

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// ModuleID is the Clipboard History module ID.
const ModuleID = "clipboard"

// Module implements core.Module. It is job-less: it only exists so the tool
// shows up in the sidebar and palette. As a pipeline step ("Copy to
// clipboard", core.StepProvider) its work runs as jobs of the hidden
// CopyModule.
type Module struct{ h *History }

// Register adds the module and its hidden step module to the registry. Pass
// the History whose clipboard the "Copy to clipboard" step writes to (main.go
// passes clipHistory); without one the step's jobs fail with "Clipboard
// unavailable". It is variadic only so callers that predate the step compile.
func Register(reg *core.Registry, history ...*History) error {
	var h *History
	if len(history) > 0 {
		h = history[0]
	}
	if err := reg.Register(Module{h: h}); err != nil {
		return err
	}
	return reg.Register(&CopyModule{h: h})
}

// Descriptor implements core.Module.
func (Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Clipboard History", Icon: "clipboard", Category: core.CategoryUtility,
		Tagline:     "Everything you copied, one hotkey away",
		Description: "A searchable, local-only history of copied text and images with a global hotkey popup.",
		Status:      core.StatusReady, Order: 300, JobLess: true,
		// Phase 11: a copied snippet opens in Dev Utilities (format, decode) inside this tool.
		Parts: []string{"dev-utils"},
	}
}

// Validate implements core.Module; job-less modules reject every job.
func (Module) Validate([]string, json.RawMessage) error { return core.ErrJobLess }

// Run implements core.Module; never called.
func (Module) Run(context.Context, *core.JobContext) error { return core.ErrJobLess }
