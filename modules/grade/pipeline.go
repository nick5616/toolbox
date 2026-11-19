package grade

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"toolbox/core"
	"toolbox/core/viz"
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
	var warnings []string
	if strings.TrimSpace(o.Vibe) != "" {
		summary = "Vibe: " + o.Vibe
		if m.cfg.Text == nil {
			warnings = append(warnings, "Download a model in Local Chat first")
		} else if _, err := m.cfg.Text.Ready(); err != nil {
			if ae := core.AsAppError(err); ae != nil {
				warnings = append(warnings, ae.Message)
			}
		}
	}
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		Produces: []core.StepProduct{
			{Role: "graded", Label: "Graded picture", Kind: core.KindImage, Exts: []string{".jpg", ".png", ".webp"}},
			{Role: "graded", Label: "Graded video", Kind: core.KindVideo, Exts: []string{".mp4"}},
		},
		Vars:      []core.StepVar{},
		Templates: []string{"/vibe"},
		Warnings:  warnings,
		Summary:   fmt.Sprintf("%s · wildness %.0f%%", summary, o.Wild*100),
	}, nil
}

// PrepareStep implements core.Chainable: one job per file. A look comes from
// the recipe the step editor stored when a look was picked (built-in looks live
// in the frontend); with a vibe the template is expanded per file and the job
// asks the chat model for the look when it runs (the runner never waits on a
// model). The step waits while no window can render.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := checkStep(o); err != nil {
		return nil, err
	}
	vibe := strings.TrimSpace(o.Vibe) != ""
	var recipe Recipe
	switch {
	case vibe:
		if m.cfg.Text == nil {
			return nil, core.ErrWaiting("Install a chat model", "Writing looks needs a model in Local Chat")
		}
		if _, err := m.cfg.Text.Ready(); err != nil {
			return nil, core.ErrWaiting("Install a chat model", "Writing looks needs a model in Local Chat")
		}
	case o.Recipe != nil:
		recipe, err = Normalize(*o.Recipe)
		if err != nil {
			return nil, core.ValidationError("This step's look isn't valid. Pick it again", map[string]string{"look": "Pick the look again"})
		}
	default:
		return nil, core.ValidationError("This step has no look. Open it and pick one", map[string]string{"look": "Pick a look"})
	}
	if err := hostWaitFn(m.cfg.Broker); err != nil {
		return nil, viz.ErrNoHost()
	}
	items := req.Items
	if len(items) == 0 {
		items = []core.StepItem{req.Item}
	}
	jobs := []core.StepJob{}
	for _, it := range items {
		for _, f := range it.Files {
			opts := Options{Recipe: recipe, Wild: o.Wild, Format: o.Format}
			if vibe {
				opts.Recipe = DefaultOptions().Recipe
				text, _ := core.ExpandVars(o.Vibe, it.Vars, core.FileVars(f))
				text = cutRunes(strings.TrimSpace(text), MaxVibeChars)
				if text == "" {
					return nil, core.ValidationError("The vibe is empty after filling in its {variables}", map[string]string{"vibe": "Write a vibe"})
				}
				opts.Vibe, opts.VibeSeed = text, o.Seed
			}
			jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: opts})
		}
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Role: "graded", RoleLabel: "Graded"})
	}
	return res, nil
}
