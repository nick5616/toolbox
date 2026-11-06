// Package documents is the Document Converter: Pandoc conversions between
// document formats, with Typst as the PDF engine (no TeX install).
package documents

import (
	"toolbox/core"
	"toolbox/core/deps"
)

// ModuleID is the Document Converter's module ID.
const ModuleID = "documents"

// Module implements core.Module and core.Chainable.
type Module struct {
	// toolsDir is core.Paths.ToolsDir; Typst's package cache lives under
	// <toolsDir>/typst/packages. Empty = a per-job folder in TempDir.
	toolsDir string
}

// New builds the module.
func New(toolsDir string) *Module { return &Module{toolsDir: toolsDir} }

// Register adds the module to the registry. toolsDir is core.Paths.ToolsDir.
func Register(reg *core.Registry, toolsDir string) error {
	return reg.Register(New(toolsDir))
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Document Converter", Icon: "file-text", Category: core.CategoryUtility,
		Tagline:      "Convert documents between docx, PDF, Markdown, EPUB and more",
		Description:  "Batch-convert documents with Pandoc; PDFs are made with Typst, so no TeX install is needed.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: Accepts()},
		Requires:     []string{deps.Pandoc, deps.Typst},
		OutputSubdir: "Documents", Order: 205, SplitInputs: true, MaxInputs: 100,
		Parts: []string{"pdf"},
	}
}
