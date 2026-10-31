package redact

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD1 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are Redact's pipeline step options; steps always use the
// "auto" action.
type StepOptions struct {
	Faces         bool        `json:"faces"`
	Plates        bool        `json:"plates"`
	Sensitivity   Sensitivity `json:"sensitivity"`
	Style         Style       `json:"style"`
	Strength      int         `json:"strength"`
	Padding       int         `json:"padding"`
	StripMetadata bool        `json:"stripMetadata"`
}

// DefaultStepOptions mirrors DefaultOptions.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{Faces: o.Faces, Plates: o.Plates, Sensitivity: o.Sensitivity, Style: o.Style,
		Strength: o.Strength, Padding: o.Padding, StripMetadata: o.StripMetadata}
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
		Produces: []core.StepProduct{{}},
		Vars:     []core.StepVar{},
		Summary:  "Redact",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Redact as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Redact as a pipeline step")
}
