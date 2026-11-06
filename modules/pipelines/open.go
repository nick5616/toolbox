package pipelines

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// openStep is Open in app (SPEC.md §4.2). Wave 0 stub; WP-O1 implements it.
type openStep struct{ m *Module }

func (o *openStep) StepDefaults() any { return DefaultOpen() }

func (o *openStep) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	if _, err := decodeStep(options, DefaultOpen()); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, URLs: true, Any: true}, NoFiles: true,
		Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: []string{"/args"}, Warnings: []string{}, Summary: "Open in app",
	}, nil
}

func (o *openStep) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Open in app")
}

func (o *openStep) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}, nil
}

func validateOpenJob(j *OpenJob) error {
	if j == nil || j.App == "" {
		return core.ValidationError("Pick an app to open", nil)
	}
	return nil
}

func (m *Module) runOpen(ctx context.Context, job *core.JobContext, o Options) error {
	return core.NotImplemented("Open in app")
}
