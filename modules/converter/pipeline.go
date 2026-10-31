package converter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): one submission with every file of the
// item; the module splits it into one job per file.

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

// stepAccepts narrows the accepted files to what the preset can read.
func stepAccepts(p presetSpec) core.Accepts {
	var exts []string
	for _, k := range p.Accepts {
		switch k {
		case core.KindAudio:
			exts = append(exts, core.AudioExtensions...)
		case core.KindVideo:
			exts = append(exts, core.VideoExtensions...)
		case core.KindImage:
			exts = append(exts, core.ImageExtensions...)
		}
	}
	return core.Accepts{Extensions: exts}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	p, ok := lookup(o.Preset)
	if !ok {
		return core.StepInfo{}, core.ValidationError("Choose a format", map[string]string{"preset": "Choose a format"})
	}
	switch o.MaxHeight {
	case HeightKeep, Height2160, Height1440, Height1080, Height720, Height480:
	default:
		return core.StepInfo{}, core.ValidationError("Choose a valid maximum height", map[string]string{"maxHeight": "Choose a valid maximum height"})
	}
	summary := p.Label
	if p.Kind != core.KindAudio && o.MaxHeight != HeightKeep {
		summary += " · ≤ " + string(o.MaxHeight) + "p"
	}
	return core.StepInfo{
		Accepts:  stepAccepts(p),
		Produces: []core.StepProduct{{Kind: p.Kind, Exts: []string{p.Ext}}},
		Vars:     []core.StepVar{},
		Summary:  summary,
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
		return nil, core.ValidationError("There's no file to convert", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal converter options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: slices.Clone(inputs), Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID})
	}
	return res, nil
}
