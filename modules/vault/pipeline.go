package vault

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2, §6.3).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD3 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are the Vault's pipeline step options: add the files to Folder
// ({vars} allowed; "" = the root).
type StepOptions struct {
	Folder string `json:"folder"`
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return StepOptions{} }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	if _, err := core.DecodeOptionsJSON[StepOptions](options); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: []core.StepProduct{},
		Vars:     []core.StepVar{},
		Summary:  "Vault",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Vault as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Vault as a pipeline step")
}
