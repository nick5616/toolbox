package audiocleanup

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD1 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are Audio Cleanup's pipeline step options (Options without the
// preview fields).
type StepOptions struct {
	HighPass bool     `json:"highPass"`
	Hum      Hum      `json:"hum"`
	Denoise  Denoise  `json:"denoise"`
	Loudness Loudness `json:"loudness"`
	Format   Format   `json:"format"`
}

// DefaultStepOptions mirrors DefaultOptions.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{HighPass: o.HighPass, Hum: o.Hum, Denoise: o.Denoise, Loudness: o.Loudness, Format: o.Format}
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
		Summary:  "Audio Cleanup",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Audio Cleanup as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Audio Cleanup as a pipeline step")
}
