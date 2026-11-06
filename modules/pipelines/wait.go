package pipelines

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// waitStep is the Wait built-in (SPEC.md §3.2). Wave 0 stub; WP-T1
// implements it: PrepareStep returns core.ErrWaitingUntil until the deadline
// (kept fixed through req.Until), then zero jobs (files pass through).
type waitStep struct{ m *Module }

func (w *waitStep) StepDefaults() any { return DefaultWait() }

func (w *waitStep) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	if _, err := decodeStep(options, DefaultWait()); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, URLs: true, Any: true}, NoFiles: true,
		Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: []string{}, Warnings: []string{}, Summary: "Wait",
	}, nil
}

func (w *waitStep) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, nil
}

func (w *waitStep) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}, nil
}
