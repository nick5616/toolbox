package compress

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"toolbox/core"
)

var _ core.Chainable = (*Module)(nil)

// Step roles.
const (
	RoleCompressed = "compressed"
	RolePart       = "part"
)

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
	if err := o.Validate(); err != nil {
		return o, plainProblem(err)
	}
	return o, nil
}

// plainProblem reduces a field error to its message.
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

// stepSummary: "under 20 MB (Discord) · split if needed".
func stepSummary(o Options) string {
	head := "under " + FormatBytes(o.Limit())
	if o.TargetID != CustomTarget {
		head += " (" + o.TargetLabel() + ")"
	}
	parts := []string{head}
	if o.IfTooSmall == TooSmallSplit {
		parts = append(parts, "split if needed")
	}
	if o.VideoCodec == CodecH265 {
		parts = append(parts, "H.265")
	}
	if o.MaxHeight > 0 {
		parts = append(parts, fmt.Sprintf("≤ %dp", o.MaxHeight))
	}
	if !o.KeepAudio {
		parts = append(parts, "no sound")
	}
	return strings.Join(parts, " · ")
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		Produces: []core.StepProduct{
			{Role: RoleCompressed, Label: "Compressed file"}, // the input's kind (a zip for other files)
			{Role: RolePart, Label: "Part", Many: true},      // when a video or audio file is split
		},
		Vars: []core.StepVar{
			{Name: "size_mb", Label: "Size (MB)", Type: core.ValueNumber},
			{Name: "fits", Label: "Fits", Type: core.ValueToggle},
			{Name: "grade", Label: "Quality", Type: core.ValueText},
		},
		Templates: []string{},
		Warnings:  []string{},
		Secrets:   []core.StepSecret{},
		Summary:   stepSummary(o),
	}, nil
}

// PrepareStep implements core.Chainable: one job per file.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if len(req.Item.Files) == 0 {
		return nil, core.ValidationError("There's no file to compress", nil)
	}
	jobs := make([]core.StepJob, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		if err := validateInputs([]string{f.Path}); err != nil {
			return nil, plainProblem(err)
		}
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: o})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	var r Result
	if job.ResultJSON != "" {
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
			return core.StepResult{}, fmt.Errorf("read compress result: %w", err)
		}
		res.Vars["size_mb"] = strconv.FormatFloat(float64(r.FinalBytes)/1_000_000, 'f', 2, 64)
		res.Vars["fits"] = strconv.FormatBool(r.Fits)
		res.Vars["grade"] = string(r.Grade)
	}
	role, label := RoleCompressed, "Compressed file"
	if r.Parts > 1 {
		role, label = RolePart, "Part"
	}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: out.Kind, OutputID: out.ID, Role: role, RoleLabel: label})
	}
	return res, nil
}
