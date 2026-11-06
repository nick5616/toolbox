package imagebatch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"toolbox/core"
)

var _ core.Chainable = (*Module)(nil)

// StepOptions are Image Batch's pipeline step options (the same fields as
// Options). In Name, {name}, {n} and {date} are filled per picture; other
// variables come from the pipeline. In the text watermark, variables come
// from the pipeline (and {name}, {ext} from the file when the step has one).
type StepOptions Options

// DefaultStepOptions are DefaultOptions().
func DefaultStepOptions() StepOptions { return StepOptions(DefaultOptions()) }

func decodeStep(raw json.RawMessage) (Options, error) {
	o := DefaultStepOptions()
	if len(bytes.TrimSpace(raw)) != 0 {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&o); err != nil {
			return Options{}, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
		}
	}
	opts := Options(o)
	if err := opts.Validate(); err != nil {
		return opts, plainProblem(err)
	}
	return opts, nil
}

func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	for _, msg := range ae.Fields {
		return core.ValidationError(msg, ae.Fields)
	}
	return err
}

func stepSummary(o Options) string {
	var parts []string
	switch o.Resize {
	case ResizeLongSide:
		parts = append(parts, fmt.Sprintf("%d px", o.LongSide))
	case ResizeExact:
		parts = append(parts, fmt.Sprintf("%d×%d", o.Width, o.Height))
	}
	if o.Aspect != "" && o.Resize != ResizeExact {
		parts = append(parts, o.Aspect+" "+string(o.Fit))
	}
	if o.Format == FormatSame {
		parts = append(parts, "same type")
	} else {
		parts = append(parts, strings.ToUpper(string(o.Format)))
	}
	if o.Watermark.Kind != WatermarkNone {
		parts = append(parts, string(o.Watermark.Kind)+" watermark")
	}
	if o.Strip {
		parts = append(parts, "no metadata")
	}
	return strings.Join(parts, " · ")
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	product := core.StepProduct{Role: "image", Label: "Picture", Kind: core.KindImage, Many: true}
	if o.Format != FormatSame {
		product.Exts = []string{o.Format.ext()}
	}
	return core.StepInfo{
		Accepts:   m.Descriptor().Accepts,
		Produces:  []core.StepProduct{product},
		Vars:      []core.StepVar{},
		Templates: []string{"/name", "/watermark/text"},
		Warnings:  []string{},
		Secrets:   []core.StepSecret{},
		Summary:   stepSummary(o),
	}, nil
}

// PrepareStep implements core.Chainable: one job with every picture of the
// item (so {n} counts through the batch).
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if len(req.Item.Files) == 0 {
		return nil, core.ValidationError("There's no picture to process", nil)
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		if err := core.ValidateFileInputs([]string{f.Path}, Accepts()); err != nil {
			return nil, plainProblem(err)
		}
		inputs = append(inputs, f.Path)
	}
	// The name keeps its per-picture tokens for the job to fill.
	keep := map[string]string{"name": "{name}", "n": "{n}", "date": "{date}"}
	o.Name, _ = core.ExpandVars(o.Name, req.Item.Vars, keep)
	maps := []map[string]string{req.Item.Vars}
	if len(req.Item.Files) == 1 {
		maps = append(maps, core.FileVars(req.Item.Files[0]))
	}
	o.Watermark.Text, _ = core.ExpandVars(o.Watermark.Text, maps...)
	if err := o.Validate(); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: core.KindImage,
			Role: "image", RoleLabel: "Picture", OutputID: out.ID})
	}
	return res, nil
}
