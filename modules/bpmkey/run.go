package bpmkey

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	_, err := core.DecodeOptionsJSON[Options](options)
	return err
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	if _, err := core.DecodeOptions[Options](job); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add at least one file", map[string]string{"inputs": "Add at least one file"})
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	input := job.Inputs[0]
	job.SetTitle(filepath.Base(input))
	outs := newOutputs(job)
	raw, err := m.sc.Call(ctx, "analysis.bpm_key", map[string]any{"input": input}, outs.onEvent)
	if err != nil {
		return err
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The audio engine returned an unreadable result").WithCause(err)
	}
	if outs.err != nil {
		return outs.err
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("%.1f BPM · %s (%s)", res.BPM, res.Key, res.Camelot))
	return nil
}
