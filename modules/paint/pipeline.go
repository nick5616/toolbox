package paint

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
)

var _ core.Chainable = (*Module)(nil)

// decodeStep reads step options strictly over the defaults.
func decodeStep(raw json.RawMessage) (StepOptions, error) {
	o := DefaultStepOptions()
	if len(bytes.TrimSpace(raw)) != 0 {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&o); err != nil {
			return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode paint step: %w", err))
		}
	}
	return o, validateStep(o)
}

// validateStep checks options that don't need the project.
func validateStep(o StepOptions) error {
	switch o.Action {
	case StepOverlay:
		if !slices.Contains([]string{"contain", "cover", "stretch"}, o.Fit) {
			return core.ValidationError("Choose how the painting fits: contain, cover or stretch", nil)
		}
	case StepDissolve:
		if o.Passes < 1 || o.Passes > 12 {
			return core.ValidationError("Passes must be 1 to 12", nil)
		}
		if o.Ghost < 0 || o.Ghost > 1 || o.Drift < 0 || o.Drift > 1 {
			return core.ValidationError("Ghost and drift must be 0 to 100%", nil)
		}
		if o.Model != "best" && o.Model != "fast" {
			return core.ValidationError("Choose the Best or Fast fill", nil)
		}
	default:
		return core.ValidationError("Choose what the step does: draw a painting over, or dissolve", nil)
	}
	if o.Project == "" && !(o.Action == StepDissolve && o.Mask != "") {
		return core.ValidationError("Choose a Paint+ painting", nil)
	}
	return nil
}

func stepSummary(o StepOptions) string {
	if o.Action == StepDissolve {
		return fmt.Sprintf("Dissolve · %d passes · ghost %d%% · drift %d%%", o.Passes, int(o.Ghost*100), int(o.Drift*100))
	}
	return "Draw a painting over · " + o.Fit
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	info := core.StepInfo{
		Accepts:   core.Accepts{Extensions: slices.Clone(media.ImageExtensions())},
		Produces:  []core.StepProduct{{Role: "image", Label: "Picture", Kind: core.KindImage, Many: true, Exts: []string{".png"}}},
		Vars:      []core.StepVar{},
		Templates: []string{},
		Warnings:  []string{},
		Secrets:   []core.StepSecret{},
		Summary:   stepSummary(o),
	}
	if err != nil {
		return info, err
	}
	if o.Action == StepDissolve {
		info.Vars = append(info.Vars, core.StepVar{Name: "passes", Label: "Passes", Type: "number"})
	}
	return info, nil
}

// PrepareStep implements core.Chainable: one job per picture (P3).
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return m.prepareStep(ctx, req)
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
	var o StepOptions
	if json.Unmarshal([]byte(job.OptionsJSON), &o) == nil && o.Action == StepDissolve {
		res.Vars["passes"] = fmt.Sprint(o.Passes)
	}
	return res, nil
}
