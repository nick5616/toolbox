package paint

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// AIModuleID is the hidden, quiet module that runs one job per perception
// tool call (SPEC.md §2.5).
const AIModuleID = "paint-ai"

// AIModule runs perception tool calls on the AI engine: it writes the crop
// and mask into <support>/tmp/paint/<jobID>/, calls paint.fill / cutout /
// segment / enhance, and keeps the result PNGs there for AIResult.
type AIModule struct{ m *Module }

// Descriptor implements core.Module.
func (a *AIModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: AIModuleID, Name: "Paint+ Lab", Icon: "brush", Category: core.CategoryImage,
		Status:   core.StatusReady,
		Accepts:  core.Accepts{Extensions: []string{}},
		Requires: []string{sidecar.DepID},
		Hidden:   true, Quiet: true, NotAStep: true,
		MaxConcurrent: 1, Immediate: true,
	}
}

// Validate implements core.Module.
func (a *AIModule) Validate(inputs []string, options json.RawMessage) error {
	return a.validate(inputs, options)
}

// Run implements core.Module.
func (a *AIModule) Run(ctx context.Context, job *core.JobContext) error { return a.run(ctx, job) }
