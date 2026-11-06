package eraser

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/imaging"
)

// Pipeline step adapter (Phase 14): automatic mode. The step erases the area
// of a mask saved in the tool from every photo of the same shape. (Manual
// mode, painting on each photo, stays the tool's own page and "I'll do this
// step myself".)

var _ core.Chainable = (*Module)(nil)

// StepOptions are what the user edits on an Object Eraser step.
type StepOptions struct {
	Model  Model  `json:"model"`
	MaskID string `json:"maskId"` // a saved mask (Service.SavedMasks)
}

// DefaultStepOptions: the best model, no mask chosen yet.
func DefaultStepOptions() StepOptions { return StepOptions{Model: ModelBest} }

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

func (m *Module) checkStep(o StepOptions) (SavedMask, error) {
	if _, ok := models[o.Model]; !ok {
		return SavedMask{}, core.ValidationError("Choose Best or Fast", map[string]string{"model": "Choose Best or Fast"})
	}
	if strings.TrimSpace(o.MaskID) == "" {
		return SavedMask{}, core.ValidationError("Choose a saved mask", map[string]string{"maskId": "Save a mask in Object Eraser first"})
	}
	sm, err := m.readMask(o.MaskID)
	if err != nil {
		return SavedMask{}, core.ValidationError("That saved mask doesn't exist any more", map[string]string{"maskId": "Choose another mask"})
	}
	return sm, nil
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	sm, err := m.checkStep(o)
	if err != nil {
		return core.StepInfo{}, err
	}
	model := "Best"
	if o.Model == ModelFast {
		model = "Fast"
	}
	return core.StepInfo{
		Accepts:  core.Accepts{Extensions: Accepts()},
		Produces: []core.StepProduct{{Role: "erased", Label: "Erased", Kind: core.KindImage}},
		Vars:     []core.StepVar{}, Secrets: []core.StepSecret{}, Templates: []string{},
		Warnings: []string{},
		Summary:  fmt.Sprintf("“%s” · %s model", sm.Name, model),
	}, nil
}

// aspectMatch reports whether two sizes have the same shape (the photo's
// displayed size already has its EXIF rotation applied, so no turned match).
func aspectMatch(mw, mh, iw, ih int) bool {
	if mw < 1 || mh < 1 || iw < 1 || ih < 1 {
		return false
	}
	m, i := float64(mw)/float64(mh), float64(iw)/float64(ih)
	return math.Abs(m-i)/i <= aspectTolerance
}

// fitsMask says why a photo can't use the mask, or "" when it can: the same
// size, or the same shape (the engine scales the mask to the photo).
func fitsMask(sm SavedMask, iw, ih int) string {
	switch {
	case iw == sm.Width && ih == sm.Height, aspectMatch(sm.Width, sm.Height, iw, ih):
		return ""
	default:
		return fmt.Sprintf("is %d×%d but the mask is %d×%d (a different shape)", iw, ih, sm.Width, sm.Height)
	}
}

// PrepareStep implements core.Chainable: one job per photo that fits the
// mask. Photos that don't are left out, with the reason in the first job's
// note; if none fit, the step fails with the reason.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	sm, err := m.checkStep(o)
	if err != nil {
		return nil, err
	}
	if m.maskDir == "" {
		return nil, core.Errorf(core.CodeInternal, "The mask folder isn't configured")
	}
	if len(req.Item.Files) == 0 {
		return nil, core.ValidationError("There are no photos to erase from", nil)
	}
	base, _ := m.maskFile(sm.ID)
	maskBytes, err := os.ReadFile(base + ".png")
	if err != nil {
		return nil, core.ValidationError("That saved mask's picture is missing", nil).WithCause(err)
	}
	var jobs []core.StepJob
	var skipped []string
	for _, f := range req.Item.Files {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name := filepath.Base(f.Path)
		sz, err := imaging.Size(f.Path)
		if err != nil {
			skipped = append(skipped, name+" couldn't be read")
			continue
		}
		if why := fitsMask(sm, sz.W, sz.H); why != "" {
			skipped = append(skipped, name+" "+why)
			continue
		}
		if err := os.MkdirAll(m.maskDir, 0o700); err != nil {
			return nil, fmt.Errorf("creating the mask folder: %w", err)
		}
		rn, err := randomName()
		if err != nil {
			return nil, err
		}
		path := filepath.Join(m.maskDir, rn)
		if err := os.WriteFile(path, maskBytes, 0o600); err != nil {
			return nil, fmt.Errorf("writing the mask: %w", err)
		}
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: Options{Model: o.Model, MaskPath: path}})
	}
	if len(jobs) == 0 {
		return nil, core.ValidationError("Skipped: "+strings.Join(skipped, "; "), nil).
			WithHint("The mask fits photos of the same shape")
	}
	if len(skipped) > 0 {
		jobs[0].Options = withNote(jobs[0].Options.(Options), "Skipped: "+strings.Join(skipped, "; "))
	}
	return jobs, nil
}

func withNote(o Options, note string) Options {
	o.Note = note
	return o
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
			Role: "erased", RoleLabel: "Erased", OutputID: out.ID})
	}
	return res, nil
}
