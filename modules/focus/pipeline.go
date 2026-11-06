package focus

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

var _ core.Chainable = (*Module)(nil)

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable. Wave 0: minimal; WP-F2 completes
// it (validation, summary, problems).
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	info := core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, URLs: true, Any: true}, NoFiles: true,
		Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: []string{}, Warnings: []string{}, Summary: "Focus",
	}
	o := DefaultStepOptions()
	if len(options) > 0 {
		if err := json.Unmarshal(options, &o); err != nil {
			return info, core.ValidationError("Invalid options", nil)
		}
	}
	if o.Action == ActionStart {
		info.Vars = []core.StepVar{
			{Name: "focus_ends", Label: "Focus ends (HH:MM)", Type: core.ValueText},
			{Name: "focus_minutes", Label: "Focus minutes", Type: core.ValueNumber},
			{Name: "focus_profile", Label: "Focus profile", Type: core.ValueText},
		}
	}
	return info, nil
}

// PrepareStep implements core.Chainable. Wave 0 stub.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Focus Lock steps")
}

// StepOutputs implements core.Chainable. Wave 0 stub.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}, nil
}
