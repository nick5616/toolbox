package upscale

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
	if o.Device == "" {
		o.Device = DeviceAuto
	}
	return o, nil
}

var modelLabels = map[Model]string{ModelPhoto: "Photo", ModelIllustration: "Illustration", ModelFast: "Fast"}

func stepSummary(o Options) string {
	parts := []string{modelLabels[o.Model], fmt.Sprintf("%d×", o.Scale)}
	switch o.Format {
	case FormatPNG:
		parts = append(parts, "PNG")
	case FormatJPG:
		parts = append(parts, "JPG")
	case FormatWebP:
		parts = append(parts, "WebP")
	}
	switch o.Device {
	case DeviceGPU:
		parts = append(parts, "GPU")
	case DeviceCPU:
		parts = append(parts, "CPU")
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
	product := core.StepProduct{Kind: core.KindImage}
	switch o.Format {
	case FormatPNG:
		product.Exts = []string{".png"}
	case FormatJPG:
		product.Exts = []string{".jpg"}
	case FormatWebP:
		product.Exts = []string{".webp"}
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
// job manager splits the inputs). An input over the size cap fails the
// submission with Validate's message.
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
	files := make([]core.RunFile, 0, len(job.Outputs))
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		files = append(files, core.RunFile{Path: out.Path, Name: name, Kind: core.KindImage, OutputID: out.ID})
	}
	return core.StepResult{Files: files, Vars: map[string]string{}}, nil
}
