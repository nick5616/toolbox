// Package organize is the Organizer: it copies files into folders by date
// taken, type, camera or a pattern, sets duplicates aside and writes a CSV
// report. It never moves, renames or changes the originals.
package organize

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/deps"
)

// ModuleID is the Organizer's module ID.
const ModuleID = "organize"

// Module implements core.Module and core.Chainable.
type Module struct {
	resolve func(depID string) (string, error)
}

// New builds the module. resolve finds tools (deps.Service.Resolve); nil, or
// a missing ExifTool, makes dates fall back to the files' modified times.
func New(resolve func(depID string) (string, error)) *Module { return &Module{resolve: resolve} }

// Register adds m to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Organizer", Icon: "folder-output", Category: core.CategoryImage,
		Tagline:     "Sort files into folders and set duplicates aside",
		Description: "Copies files (originals are never moved) into folders by date taken, type, camera or your own pattern. Finds exact and look-alike duplicates and writes a CSV report.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Any: true},
		Recommends:  []string{deps.ExifTool},
		Order:       165, OutputSubdir: "Organized",
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }

// exifPath resolves ExifTool, or "" when it isn't available.
func (m *Module) exifPath() string {
	if m == nil || m.resolve == nil {
		return ""
	}
	p, err := m.resolve(deps.ExifTool)
	if err != nil {
		return ""
	}
	return p
}
