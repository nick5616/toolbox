package captions

import (
	"context"
	"encoding/json"
	"strings"

	"toolbox/core"
)

// "Write captions" step (SPEC.md §5.5). StepDefaults and DescribeStep are
// final; C2 implements PrepareStep and StepOutputs.

var _ core.Chainable = (*Module)(nil)

// Step roles and variables.
const (
	RoleCaptioned = "captioned"
	RoleTable     = "table"
)

// StepVars are the variables a step makes (per file).
func StepVars() []core.StepVar {
	return []core.StepVar{
		{Name: "alt", Label: "Alt text", Type: core.ValueText},
		{Name: "caption", Label: "Caption", Type: core.ValueText},
		{Name: "hashtags", Label: "Hashtags", Type: core.ValueText},
		{Name: "title", Label: "Title", Type: core.ValueText},
		{Name: "description", Label: "Description", Type: core.ValueText},
		{Name: "keywords", Label: "Keywords", Type: core.ValueText},
		{Name: "name", Label: "Suggested name", Type: core.ValueText},
	}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	products := []core.StepProduct{
		{Role: RoleTable, Label: "Captions table", Kind: core.KindDocument, Exts: []string{".csv"}},
	}
	switch o.Then {
	case ThenWriteCopies:
		products = append(products, core.StepProduct{Role: RoleCaptioned, Label: "Copies with captions", Many: true})
	case ThenRenameCopies:
		products = append(products, core.StepProduct{Role: RoleCaptioned, Label: "Renamed copies", Many: true})
	}
	names := make([]string, 0, 7)
	for _, f := range PresetFields(o.Preset) {
		names = append(names, string(f))
	}
	var warnings []string
	if _, err := m.visionModel(); err != nil {
		if ae := core.AsAppError(err); ae != nil {
			warnings = append(warnings, ae.Message)
		}
	}
	return core.StepInfo{
		Accepts:   m.Descriptor().Accepts,
		Produces:  products,
		Vars:      StepVars(),
		Templates: []string{"/context"},
		Warnings:  warnings,
		Summary:   strings.Join(names, ", "),
	}, nil
}

// visionModel is the model that will read pictures.
func (m *Module) visionModel() (string, error) {
	if m.cfg.Vision == nil {
		return "", core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack to read pictures")
	}
	return m.cfg.Vision.Vision()
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.Errorf(core.CodeNotImplemented, "This step isn't ready yet")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.Errorf(core.CodeNotImplemented, "This step isn't ready yet")
}
