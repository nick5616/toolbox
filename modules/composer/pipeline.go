package composer

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
)

// Pipeline step adapter: "Fill a template" (Phase 14 A2). A saved composition
// is the template; each input, or each group of N for a template with N photo
// slots, fills it and is rendered.

var _ core.Chainable = (*Module)(nil)

// StepOptions are the Fill a template step's options.
type StepOptions struct {
	TemplateID   string  `json:"templateId"`   // the saved composition
	TemplateName string  `json:"templateName"` // a label only
	Format       string  `json:"format"`       // "" = the template's | "jpg" | "png"
	Scale        float64 `json:"scale"`        // 0 = 1
	Name         string  `json:"name"`         // output file name; takes {vars}; "" = "<template> - <photo>"
}

// DefaultStepOptions: pick a template in the step editor.
func DefaultStepOptions() StepOptions { return StepOptions{Scale: 1} }

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

func bad(field, msg string) error {
	return core.ValidationError(msg, map[string]string{field: msg})
}

func (s StepOptions) jobOptions() Options {
	return Options{ProjectID: s.TemplateID, Format: s.Format, Scale: s.Scale, Name: s.Name}
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	s, err := core.DecodeOptionsJSON[StepOptions](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	info := core.StepInfo{
		Accepts:   core.Accepts{Extensions: media.ImageExtensions()},
		Produces:  []core.StepProduct{{Role: "image", Label: "Picture", Kind: core.KindImage, Exts: []string{".jpg", ".png"}, Many: true}},
		Vars:      []core.StepVar{},
		Templates: []string{"/name"}, Warnings: []string{}, Secrets: []core.StepSecret{},
		Summary: "Fill a template",
	}
	if s.TemplateID == "" {
		return info, bad("templateId", "Pick a template")
	}
	if err := s.jobOptions().validate(); err != nil {
		return info, err
	}
	slots, err := m.Slots(context.Background(), s.TemplateID)
	if err != nil {
		return info, bad("templateId", "The template isn't there any more. Pick another")
	}
	if len(slots.Slots) == 0 {
		return info, bad("templateId", "This template has no photo layers to fill")
	}
	info.Summary = "Fill " + slots.Name
	if n := len(slots.Slots); n > 1 {
		info.Summary += fmt.Sprintf(" · %d photos each", n)
	}
	return info, nil
}

// PrepareStep implements core.Chainable: one job per group of photos. It waits
// while no window is open to draw in.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	s, err := core.DecodeOptionsJSON[StepOptions](req.Options)
	if err != nil {
		return nil, err
	}
	if err := s.jobOptions().validate(); err != nil {
		return nil, err
	}
	doc, err := m.Get(ctx, s.TemplateID)
	if err != nil {
		return nil, err
	}
	n := len(SlotIndexes(doc))
	if n == 0 {
		return nil, bad("templateId", "This template has no photo layers to fill")
	}
	if err := m.cfg.Broker.WaitForHost(); err != nil {
		return nil, err
	}
	var jobs []core.StepJob
	files := req.Item.Files
	for i := 0; i < len(files); i += n {
		group := files[i:min(i+n, len(files))]
		paths := make([]string, len(group))
		for j, f := range group {
			paths[j] = f.Path
		}
		o := s.jobOptions()
		if strings.TrimSpace(s.Name) != "" {
			o.Name, _ = core.ExpandVars(s.Name, req.Item.Vars, core.FileVars(group[0]))
		}
		jobs = append(jobs, core.StepJob{Inputs: paths, Options: o})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: make([]core.RunFile, 0, len(job.Outputs)), Vars: map[string]string{}}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: core.KindImage, OutputID: out.ID, Role: "image", RoleLabel: "Picture"})
	}
	return res, nil
}
