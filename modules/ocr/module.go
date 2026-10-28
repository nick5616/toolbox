// Package ocr turns images into text and scanned PDFs into searchable PDFs
// (RapidOCR in the AI engine). See SPEC.md §5.
//
// CONTRACT STUB (foundation): options.go, module.go and service.go are
// final; OC1 implements run.go and fills presets.go. Exported signatures are
// frozen.
package ocr

import (
	"context"
	"encoding/json"
	"image"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ModuleID is the OCR module ID.
const ModuleID = "ocr"

// Renderer renders PDF pages (core/pdfium.Renderer implements it).
type Renderer interface {
	PageCount(ctx context.Context, doc []byte, password string) (int, error)
	Render(ctx context.Context, doc []byte, password string, page, dpi int) (image.Image, error)
	PageText(ctx context.Context, doc []byte, password string, page int) (string, error)
}

// Module implements core.Module.
type Module struct {
	sc        sidecar.Caller
	pdf       Renderer
	modelsDir string // models go in <modelsDir>/ocr/
}

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, pdf Renderer, modelsDir string) error {
	return reg.Register(&Module{sc: sc, pdf: pdf, modelsDir: modelsDir})
}

// Accepts lists the input extensions.
func Accepts() []string {
	return []string{".pdf", ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "OCR", Icon: "scan-text", Category: core.CategoryDocument,
		Tagline:     "Turn scans and photos into text",
		Description: "Extract text from images and make scanned PDFs searchable, offline.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID},
		Order:       195, OutputSubdir: "OCR",
		SplitInputs: true, MaxConcurrent: 1, MaxInputs: 200,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return m.run(ctx, job)
}
