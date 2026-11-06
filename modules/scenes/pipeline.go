package scenes

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

// Pipeline step adapter: one job per video; the clips and stills go on as
// the roles "scene" and "still".

var _ core.Chainable = (*Module)(nil)

// StepOptions are the Scene Splitter's pipeline step options (the same
// fields as Options; nothing in them depends on the file).
type StepOptions struct {
	Threshold    float64 `json:"threshold"`
	MinSceneSecs float64 `json:"minSceneSecs"`
	Output       Output  `json:"output"`
	Keep         Keep    `json:"keep"`
	KeepN        int     `json:"keepN"`
}

// DefaultStepOptions: stills of every scene (what a storyboard needs).
func DefaultStepOptions() StepOptions {
	d := DefaultOptions()
	return StepOptions{Threshold: d.Threshold, MinSceneSecs: d.MinSceneSecs, Output: OutputStills, Keep: d.Keep, KeepN: d.KeepN}
}

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

func stepSummary(o StepOptions) string {
	what := map[Output]string{OutputClips: "Clips", OutputStills: "Stills", OutputBoth: "Clips + stills"}[o.Output]
	parts := []string{what, "sensitivity " + strconv.FormatFloat(o.Threshold, 'f', -1, 64)}
	switch o.Keep {
	case KeepLongest:
		parts = append(parts, fmt.Sprintf("%d longest", o.KeepN))
	case KeepActive:
		parts = append(parts, fmt.Sprintf("%d most active", o.KeepN))
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
	if err := checkOptions(o.toOptions()); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	var produces []core.StepProduct
	if o.Output != OutputStills {
		produces = append(produces, core.StepProduct{Role: "scene", Label: "Scene clip", Kind: core.KindVideo, Many: true})
	}
	if o.Output != OutputClips {
		produces = append(produces, core.StepProduct{Role: "still", Label: "Scene still", Kind: core.KindImage, Exts: []string{".jpg"}, Many: true})
	}
	return core.StepInfo{
		Accepts:   m.Descriptor().Accepts,
		Produces:  produces,
		Vars:      []core.StepVar{{Name: "scene", Label: "Scenes kept", Type: core.ValueNumber}, {Name: "scene_total", Label: "Scenes found", Type: core.ValueNumber}},
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
		return nil, core.ValidationError("There's no video to split", nil)
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
		role, label := "scene", "Scene clip"
		if strings.EqualFold(filepath.Ext(out.Path), ".jpg") {
			role, label = "still", "Scene still"
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: out.Kind, Role: role, RoleLabel: label, OutputID: out.ID})
	}
	if job.ResultJSON != "" {
		var r Result
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err == nil {
			res.Vars["scene"] = strconv.Itoa(len(r.Scenes))
			res.Vars["scene_total"] = strconv.Itoa(r.Found)
		}
	}
	return res, nil
}
