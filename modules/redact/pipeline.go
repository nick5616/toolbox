package redact

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): per item, all images go in one job
// and each video runs alone (Redact takes one video at a time).

var _ core.Chainable = (*Module)(nil)

// StepOptions are Redact's pipeline step options; steps always use the
// "auto" action.
type StepOptions struct {
	Faces         bool        `json:"faces"`
	Plates        bool        `json:"plates"`
	Sensitivity   Sensitivity `json:"sensitivity"`
	Style         Style       `json:"style"`
	Strength      int         `json:"strength"`
	Padding       int         `json:"padding"`
	StripMetadata bool        `json:"stripMetadata"`
}

// DefaultStepOptions mirrors DefaultOptions.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{Faces: o.Faces, Plates: o.Plates, Sensitivity: o.Sensitivity, Style: o.Style,
		Strength: o.Strength, Padding: o.Padding, StripMetadata: o.StripMetadata}
}

// toOptions is the job's options: detect and apply in one go.
func (s StepOptions) toOptions() Options {
	o := DefaultOptions()
	o.Action = ActionAuto
	o.Faces, o.Plates, o.Sensitivity, o.Style = s.Faces, s.Plates, s.Sensitivity, s.Style
	o.Strength, o.Padding, o.StripMetadata = s.Strength, s.Padding, s.StripMetadata
	return o
}

// decodeStep decodes step options strictly over the defaults.
func decodeStep(raw json.RawMessage) (StepOptions, error) {
	o := DefaultStepOptions()
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

func stepSummary(s StepOptions) string {
	what := "Faces & plates"
	switch {
	case s.Faces && !s.Plates:
		what = "Faces"
	case s.Plates && !s.Faces:
		what = "Number plates"
	}
	style := map[Style]string{StyleBlur: "blur", StylePixelate: "pixelate", StyleSolid: "solid"}[s.Style]
	if style == "" {
		style = string(s.Style)
	}
	return what + " · " + style
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	s, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if ve := validateOptions(s.toOptions()); ve != nil {
		return core.StepInfo{}, plainProblem(ve)
	}
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		// Images keep their format (TIFF becomes PNG, HEIC becomes JPEG) and
		// videos become MP4, so no kind or extension is promised.
		Produces: []core.StepProduct{{}},
		Vars:     []core.StepVar{},
		Summary:  stepSummary(s),
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	s, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if len(req.Item.Files) == 0 {
		return nil, core.ValidationError("There's no photo or video to redact", nil)
	}
	paths := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		paths = append(paths, f.Path)
	}
	images, videos := split(paths)
	opts := s.toOptions()
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal redact options: %w", err)
	}
	var groups [][]string
	if len(images) > 0 {
		groups = append(groups, images)
	}
	for _, v := range videos {
		groups = append(groups, []string{v})
	}
	jobs := make([]core.StepJob, 0, len(groups))
	for _, g := range groups {
		if err := m.Validate(g, raw); err != nil {
			return nil, plainProblem(err)
		}
		jobs = append(jobs, core.StepJob{Inputs: g, Options: opts})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID})
	}
	return res, nil
}
