package silence

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

// StepOptions are the Silence Cutter's pipeline step options (the same
// fields as Options).
type StepOptions struct {
	ThresholdDb  float64 `json:"thresholdDb"`
	MinSilenceMs int     `json:"minSilenceMs"`
	PaddingMs    int     `json:"paddingMs"`
	CrossfadeMs  int     `json:"crossfadeMs"`
	CutList      bool    `json:"cutList"`
}

// DefaultStepOptions are the defaults of DefaultOptions().
func DefaultStepOptions() StepOptions {
	d := DefaultOptions()
	return StepOptions{d.ThresholdDb, d.MinSilenceMs, d.PaddingMs, d.CrossfadeMs, d.CutList}
}

func (s StepOptions) options() Options {
	return Options{ThresholdDb: s.ThresholdDb, MinSilenceMs: s.MinSilenceMs, PaddingMs: s.PaddingMs, CrossfadeMs: s.CrossfadeMs, CutList: s.CutList}
}

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
	if err := o.options().Validate(); err != nil {
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

func stepSummary(o StepOptions) string {
	parts := []string{
		fmt.Sprintf("below %s dB", strconv.FormatFloat(o.ThresholdDb, 'f', -1, 64)),
		fmt.Sprintf("over %s s", strconv.FormatFloat(float64(o.MinSilenceMs)/1000, 'f', -1, 64)),
		fmt.Sprintf("%d ms padding", o.PaddingMs),
	}
	if o.CutList {
		parts = append(parts, "cut list")
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
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		Produces: []core.StepProduct{
			{Role: "cut", Label: "Cut file"}, // the input's kind: .mp4 for video, its own family for audio
			{Role: "cutlist", Label: "Cut list", Kind: core.KindOther, Exts: []string{".csv"}},
		},
		Vars: []core.StepVar{
			{Name: "removed_s", Label: "Seconds removed", Type: core.ValueNumber},
			{Name: "kept_s", Label: "Seconds kept", Type: core.ValueNumber},
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
		return nil, core.ValidationError("There's no file to cut", nil)
	}
	jobs := make([]core.StepJob, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		if err := core.ValidateFileInputs([]string{f.Path}, Accepts()); err != nil {
			return nil, plainProblem(err)
		}
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: o.options()})
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
		f := core.RunFile{Path: out.Path, Name: name, Kind: out.Kind, OutputID: out.ID, Role: "cut", RoleLabel: "Cut file"}
		if strings.EqualFold(filepath.Ext(out.Path), ".csv") {
			f.Role, f.RoleLabel = "cutlist", "Cut list"
		}
		res.Files = append(res.Files, f)
	}
	if job.ResultJSON != "" {
		var r Result
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
			return core.StepResult{}, fmt.Errorf("read silence cutter result: %w", err)
		}
		res.Vars["removed_s"] = strconv.FormatFloat(float64(r.RemovedMs)/1000, 'f', 1, 64)
		res.Vars["kept_s"] = strconv.FormatFloat(float64(r.KeptMs)/1000, 'f', 1, 64)
	}
	return res, nil
}
