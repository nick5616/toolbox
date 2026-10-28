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
// shows up in the sidebar and palette.
type Module struct{}

// Register adds the module to the registry.
func Register(reg *core.Registry) error { return reg.Register(Module{}) }

// Descriptor implements core.Module.
func (Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Clipboard History", Icon: "clipboard", Category: core.CategoryUtility,
		Tagline:     "Everything you copied, one hotkey away",
		Description: "A searchable, local-only history of copied text and images with a global hotkey popup.",
		Status:      core.StatusReady, Order: 300, JobLess: true,
	}
}

// Validate implements core.Module; job-less modules reject every job.
func (Module) Validate([]string, json.RawMessage) error { return core.ErrJobLess }

// Run implements core.Module; never called.
func (Module) Run(context.Context, *core.JobContext) error { return core.ErrJobLess }
