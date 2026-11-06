package gif

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter: one job per video; a "gif" (GIF or WebP) or a "sheet".

var _ core.Chainable = (*Module)(nil)

// StepOptions are the pipeline step options (the same fields as Options).
type StepOptions struct {
	Mode      Mode    `json:"mode"`
	StartSec  float64 `json:"startSec"`
	LengthSec float64 `json:"lengthSec"`
	FPS       int     `json:"fps"`
	Width     int     `json:"width"`
	Loop      bool    `json:"loop"`
	Columns   int     `json:"columns"`
	Rows      int     `json:"rows"`
	CellWidth int     `json:"cellWidth"`
	Labels    bool    `json:"labels"`
}

// DefaultStepOptions are the defaults of DefaultOptions.
func DefaultStepOptions() StepOptions { return StepOptions(DefaultOptions()) }

func (o StepOptions) toOptions() Options { return Options(o) }

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

// plainProblem turns a field error into its message.
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

func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

func stepSummary(o StepOptions) string {
	if o.Mode == ModeSheet {
		s := fmt.Sprintf("Contact sheet · %d × %d", o.Columns, o.Rows)
		if o.Labels {
			s += " · timecodes"
		}
		return s
	}
	kind := "GIF"
	if o.Mode == ModeWebP {
		kind = "WebP"
	}
	s := fmt.Sprintf("%s · %s s from %s s · %d fps · %d px", kind, num(o.LengthSec), num(o.StartSec), o.FPS, o.Width)
	if !o.Loop {
		s += " · plays once"
	}
	return s
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := checkOptions(o.toOptions()); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	product := core.StepProduct{Role: "gif", Label: "GIF", Kind: core.KindImage, Exts: []string{".gif"}}
	switch o.Mode {
	case ModeWebP:
		product.Label, product.Exts = "Animated WebP", []string{".webp"}
	case ModeSheet:
		product.Role, product.Label, product.Exts = "sheet", "Contact sheet", []string{".jpg"}
	}
	return core.StepInfo{
		Accepts:   m.Descriptor().Accepts,
		Produces:  []core.StepProduct{product},
		Vars:      []core.StepVar{},
		Templates: []string{},
		Summary:   stepSummary(o),
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := checkOptions(o.toOptions()); err != nil {
		return nil, plainProblem(err)
	}
	if len(req.Item.Files) == 0 {
		return nil, core.ValidationError("There's no video to use", nil)
	}
	jobs := make([]core.StepJob, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		if err := core.ValidateFileInputs([]string{f.Path}, Accepts()); err != nil {
			return nil, plainProblem(err)
		}
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: o.toOptions()})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		role, label := "gif", "GIF"
		switch strings.ToLower(filepath.Ext(out.Path)) {
		case ".webp":
			label = "Animated WebP"
		case ".jpg":
			role, label = "sheet", "Contact sheet"
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: out.Kind, Role: role, RoleLabel: label, OutputID: out.ID})
	}
	return res, nil
}
