package stems

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): one submission with every file of the
// item; the module splits it into one job per file. Roles come from the
// engine's stem names, lowercased.

var _ core.Chainable = (*Module)(nil)

// decodeStep decodes step options strictly over the defaults, so unset
// fields keep their defaults.
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
	if err := validateOptions(o); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	spec := presets[o.Preset]
	ext := "." + string(o.Format)
	products := make([]core.StepProduct, 0, len(spec.Stems))
	for _, s := range spec.Stems {
		products = append(products, core.StepProduct{Role: strings.ToLower(s), Label: s, Kind: core.KindAudio, Exts: []string{ext}})
	}
	count := "4 stems"
	if len(spec.Stems) == 2 {
		count = "Vocals + instrumental"
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: products,
		Vars:     []core.StepVar{},
		Summary:  count + " · " + spec.Speed + " · " + strings.ToUpper(string(o.Format)),
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
		return nil, core.ValidationError("There's no file to split", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal stems options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	var r separateResult
	if job.ResultJSON != "" {
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
			return res, fmt.Errorf("read stems result: %w", err)
		}
	}
	names := map[string]string{} // cleaned output path → stem name
	for _, s := range r.Stems {
		names[filepath.Clean(s.Path)] = s.Name
	}
	for _, out := range job.Outputs {
		f := core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID}
		if n, ok := names[filepath.Clean(out.Path)]; ok {
			f.Role, f.RoleLabel = strings.ToLower(n), n
		}
		res.Files = append(res.Files, f)
	}
	return res, nil
}
