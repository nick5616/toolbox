package grade

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"toolbox/core"
)

// Pipeline step "Grade with a look" (SPEC §E1): one job per file; a picture
// or video with role "graded". G2 completes PrepareStep (vibe templates, look
// lookup, ErrWaiting without a render host).

var _ core.Chainable = (*Module)(nil)

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

func checkStep(o StepOptions) error {
	if o.Wild < 0 || o.Wild > 1 {
		return core.ValidationError("Wildness is 0 to 1", map[string]string{"wild": "Wildness is 0 to 1"})
	}
	switch o.Format {
	case "same", "jpg", "png", "webp":
	default:
		return core.ValidationError("Pick a format", map[string]string{"format": "Pick a format"})
	}
	if strings.TrimSpace(o.Look) == "" && strings.TrimSpace(o.Vibe) == "" {
		return core.ValidationError("Pick a look or write a vibe", map[string]string{"look": "Pick a look or write a vibe"})
	}
	return nil
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := checkStep(o); err != nil {
		return core.StepInfo{}, err
	}
	summary := "Look: " + o.Look
	if strings.TrimSpace(o.Vibe) != "" {
		summary = "Vibe: " + o.Vibe
	}
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		Produces: []core.StepProduct{
			{Role: "graded", Label: "Graded picture", Kind: core.KindImage, Exts: []string{".jpg", ".png", ".webp"}},
			{Role: "graded", Label: "Graded video", Kind: core.KindVideo, Exts: []string{".mp4"}},
		},
		Vars:      []core.StepVar{},
		Templates: []string{"/vibe"},
		Summary:   fmt.Sprintf("%s · wildness %.0f%%", summary, o.Wild*100),
	}, nil
}

// PrepareStep implements core.Chainable. G2 completes it.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := checkStep(o); err != nil {
		return nil, err
	}
	return nil, core.Errorf(core.CodeInternal, "Color Grader steps aren't ready yet")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Role: "graded", RoleLabel: "Graded"})
	}
	return res, nil
}
