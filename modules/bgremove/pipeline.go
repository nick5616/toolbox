package bgremove

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2). The step options are Options.

var _ core.Chainable = (*Module)(nil)

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// decodeStep decodes strictly over the defaults, so a partial object keeps
// the default for every field it leaves out.
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

var colorNames = map[string]string{"#ffffff": "white", "#000000": "black"}

func stepSummary(o Options) string {
	parts := []string{strings.ToUpper(string(o.Model[:1])) + string(o.Model[1:])}
	switch o.Output {
	case OutputColor:
		name, ok := colorNames[strings.ToLower(o.Color)]
		if !ok {
			name = strings.ToLower(o.Color)
		}
		parts = append(parts, "on "+name)
	case OutputMask:
		parts = append(parts, "mask only")
	default:
		parts = append(parts, "transparent")
	}
	if o.Crop {
		parts = append(parts, "cropped")
	}
	return strings.Join(parts, " · ")
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := validateOptions(o); err != nil {
		return core.StepInfo{}, err
	}
	product := core.StepProduct{Role: "cutout", Label: "Cutout", Kind: core.KindImage, Exts: []string{".png"}}
	if o.Output == OutputMask {
		product = core.StepProduct{Role: "mask", Label: "Mask", Kind: core.KindImage, Exts: []string{".png"}}
	}
	return core.StepInfo{
		Accepts:   m.Descriptor().Accepts,
		Produces:  []core.StepProduct{product},
		Vars:      []core.StepVar{},
		Secrets:   []core.StepSecret{},
		Templates: []string{},
		Warnings:  []string{},
		Summary:   stepSummary(o),
	}, nil
}

// PrepareStep implements core.Chainable: one submission with every file (the
// job manager splits the inputs).
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := validateOptions(o); err != nil {
		return nil, err
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		inputs = append(inputs, f.Path)
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("Add at least one image", map[string]string{"inputs": "Add at least one image"})
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	role, label := "cutout", "Cutout"
	if job.OptionsJSON != "" {
		var o Options
		if err := json.Unmarshal([]byte(job.OptionsJSON), &o); err != nil {
			return core.StepResult{}, fmt.Errorf("read background remover job options: %w", err)
		}
		if o.Output == OutputMask {
			role, label = "mask", "Mask"
		}
	}
	files := make([]core.RunFile, 0, len(job.Outputs))
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		files = append(files, core.RunFile{Path: out.Path, Name: name, Kind: core.KindImage,
			Role: role, RoleLabel: label, OutputID: out.ID})
	}
	return core.StepResult{Files: files, Vars: map[string]string{}}, nil
}
