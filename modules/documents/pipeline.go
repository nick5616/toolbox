package documents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"

	"toolbox/core"
)

// Pipeline step adapter: one submission with every file of the item; the
// module splits it into one job per file.

var _ core.Chainable = (*Module)(nil)

// decodeStep decodes step options strictly over the defaults.
func decodeStep(raw json.RawMessage) (Options, error) {
	o := DefaultOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return o, nil
}

// plainProblem turns a field-validation error into one whose message is the
// first field's message.
func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	keys := make([]string, 0, len(ae.Fields))
	for k := range ae.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return core.ValidationError(ae.Fields[keys[0]], ae.Fields)
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	to, ok := lookupFormat(o.To)
	if !ok {
		return core.StepInfo{}, core.ValidationError("Choose a format", map[string]string{"to": "Choose a format"})
	}
	// Option ranges are checked by Validate with a placeholder-free probe.
	if err := checkOptions(o); err != nil {
		return core.StepInfo{}, err
	}
	role, label := "document", "Document"
	if o.To == FormatPDF {
		role, label = "pdf", "PDF"
	}
	return core.StepInfo{
		Accepts:   core.Accepts{Extensions: Accepts()},
		Produces:  []core.StepProduct{{Role: role, Label: label, Kind: core.KindDocument, Exts: []string{to.Ext}}},
		Vars:      []core.StepVar{{Name: "format", Label: "Format", Type: core.ValueText}},
		Secrets:   []core.StepSecret{},
		Templates: []string{},
		Warnings:  []string{},
		Summary:   "To " + to.Label,
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		inputs = append(inputs, f.Path)
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("There's no document to convert", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal documents options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: slices.Clone(inputs), Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	role := "document"
	vars := map[string]string{}
	var o Options
	if err := json.Unmarshal([]byte(job.OptionsJSON), &o); err == nil {
		vars["format"] = string(o.To)
		if o.To == FormatPDF {
			role = "pdf"
		}
	}
	res := core.StepResult{Files: []core.RunFile{}, Vars: vars}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID, Role: role})
	}
	return res, nil
}
