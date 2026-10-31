package pdf

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2, §6.3).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD3 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are PDF Toolkit's pipeline step options. Organize and range
// splits need one specific document, so they aren't offered.
type StepOptions struct {
	Action      Action `json:"action"` // merge | split | compress | images-to-pdf | pdf-to-images | protect | unlock
	Every       int    `json:"every"`  // split: pages per file, ≥ 1
	Level       string `json:"level"`
	PageSize    string `json:"pageSize"`
	Margin      string `json:"margin"`
	ImageFormat string `json:"imageFormat"`
	DPI         int    `json:"dpi"`
}

// DefaultStepOptions mirrors DefaultOptions (merge).
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{Action: o.Action, Every: o.Every, Level: o.Level, PageSize: o.PageSize,
		Margin: o.Margin, ImageFormat: o.ImageFormat, DPI: o.DPI}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	if _, err := core.DecodeOptionsJSON[StepOptions](options); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: []core.StepProduct{{Role: "pdf", Label: "PDF", Kind: core.KindDocument, Exts: []string{".pdf"}}},
		Vars:     []core.StepVar{},
		Summary:  "PDF Toolkit",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("PDF Toolkit as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("PDF Toolkit as a pipeline step")
}
