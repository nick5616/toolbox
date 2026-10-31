package bpmkey

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): one submission with every file of the
// item; the module splits it into one job per file. The step makes no files,
// only variables.

var _ core.Chainable = (*Module)(nil)

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return Options{} }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	if _, err := core.DecodeOptionsJSON[Options](options); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: []core.StepProduct{},
		Vars:     []core.StepVar{{Name: "bpm", Label: "BPM"}, {Name: "bpm_exact", Label: "BPM (exact)"}, {Name: "key", Label: "Key"}, {Name: "key_short", Label: "Key (short)"}, {Name: "camelot", Label: "Camelot"}},
		Summary:  "BPM & Key",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := core.DecodeOptionsJSON[Options](req.Options)
	if err != nil {
		return nil, err
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		inputs = append(inputs, f.Path)
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("There's no file to analyse", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal bpm-key options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// plainProblem gives a field-validation error its first field message.
func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	best := ""
	for k := range ae.Fields {
		if best == "" || k < best {
			best = k
		}
	}
	return core.ValidationError(ae.Fields[best], ae.Fields)
}

// keyShort turns "A minor" into "Am" and "F# major" into "F#".
func keyShort(key string) string {
	note, mode, ok := strings.Cut(strings.TrimSpace(key), " ")
	if !ok {
		return note
	}
	if strings.EqualFold(strings.TrimSpace(mode), "minor") {
		return note + "m"
	}
	return note
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	if job.ResultJSON == "" {
		return res, core.Errorf(core.CodeInternal, "The analysis returned no result")
	}
	var r Result
	if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
		return res, fmt.Errorf("read bpm-key result: %w", err)
	}
	res.Vars["bpm"] = strconv.Itoa(int(math.Round(r.BPM)))
	res.Vars["bpm_exact"] = strconv.FormatFloat(r.BPM, 'f', 1, 64)
	res.Vars["key"] = r.Key
	res.Vars["key_short"] = keyShort(r.Key)
	res.Vars["camelot"] = r.Camelot
	return res, nil
}
