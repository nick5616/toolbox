package exif

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2). The step options are Options; the
// values in Fields take {vars}.

var _ core.Chainable = (*Module)(nil)

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// decodeStep decodes strictly over the defaults, so a partial object keeps
// the default for every field it leaves out.
func decodeStep(raw json.RawMessage) (Options, error) {
	o := DefaultOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	if o.Fields == nil {
		o.Fields = map[string]string{}
	}
	return o, nil
}

// placeholderDate stands in for a templated date so Describe can check the
// other rules without values.
const placeholderDate = "2000:01:01 00:00:00"

// checkStep validates the action and, for edits, the field values (with
// every {var} replaced by a stand-in; a templated date is not format-checked).
func checkStep(o Options) error {
	if !slices.Contains([]Action{ActionStripLocation, ActionStripAll, ActionEdit}, o.Action) {
		return core.ValidationError("Choose what to do with the metadata", map[string]string{"action": "Unknown action"})
	}
	if o.Action != ActionEdit {
		return nil
	}
	probe := make(map[string]string, len(o.Fields))
	for k, v := range o.Fields {
		vals := map[string]string{}
		for _, n := range core.TemplateVars(v) {
			vals[n] = "x"
		}
		out, _ := core.ExpandVars(v, vals)
		if k == FieldDateTimeOriginal && len(vals) > 0 {
			out = placeholderDate
		}
		probe[k] = out
	}
	if bad := validateFields(probe); len(bad) > 0 {
		return core.ValidationError("Check the fields", bad)
	}
	return nil
}

func stepSummary(o Options) string {
	switch o.Action {
	case ActionStripLocation:
		return "Strip location"
	case ActionStripAll:
		if o.KeepOrientation {
			return "Strip all metadata · keep orientation"
		}
		return "Strip all metadata"
	}
	names := []string{}
	for _, f := range EditableFields() {
		if _, ok := o.Fields[f]; ok {
			names = append(names, f)
		}
	}
	if len(names) > 0 && len(names) <= 2 {
		return "Edit " + strings.Join(names, ", ")
	}
	return fmt.Sprintf("Edit %d %s", len(o.Fields), plural(len(o.Fields), "field", "fields"))
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := checkStep(o); err != nil {
		return core.StepInfo{}, err
	}
	templates := []string{}
	if o.Action == ActionEdit {
		for _, f := range EditableFields() {
			templates = append(templates, "/fields/"+f)
		}
	}
	return core.StepInfo{
		Accepts:   core.Accepts{Extensions: slices.Clone(writableExtensions)},
		Produces:  []core.StepProduct{{}},
		Vars:      []core.StepVar{},
		Secrets:   []core.StepSecret{},
		Templates: templates,
		Warnings:  []string{},
		Summary:   stepSummary(o),
	}, nil
}

// PrepareStep implements core.Chainable. One submission with every file,
// unless an edited field uses a {var}: then one job per file, each with the
// field values expanded over the item's variables and the file's built-ins.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := checkStep(o); err != nil {
		return nil, err
	}
	files := req.Item.Files
	if len(files) == 0 {
		return nil, core.ValidationError("Add at least one image", map[string]string{"inputs": "Add at least one image"})
	}
	templated := false
	if o.Action == ActionEdit {
		for _, v := range o.Fields {
			if len(core.TemplateVars(v)) > 0 {
				templated = true
				break
			}
		}
	}
	if !templated {
		inputs := make([]string, 0, len(files))
		for _, f := range files {
			inputs = append(inputs, f.Path)
		}
		if o.Action == ActionEdit {
			// Unescape "{{" and "}}" the same way as the templated path.
			o.Fields = expandFields(o.Fields, nil)
			if bad := validateFields(o.Fields); len(bad) > 0 {
				return nil, core.ValidationError("Check the fields", bad)
			}
		}
		return []core.StepJob{{Inputs: inputs, Options: o}}, nil
	}
	jobs := make([]core.StepJob, 0, len(files))
	for _, f := range files {
		fo := o
		fo.Fields = expandFields(o.Fields, []map[string]string{req.Item.Vars, core.FileVars(f)})
		if bad := validateFields(fo.Fields); len(bad) > 0 {
			return nil, core.ValidationError(filepath.Base(f.Path)+": check the fields", bad)
		}
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: fo})
	}
	return jobs, nil
}

func expandFields(fields map[string]string, maps []map[string]string) map[string]string {
	out := make(map[string]string, len(fields))
	for k, v := range fields {
		out[k], _ = core.ExpandVars(v, maps...)
	}
	return out
}

// StepOutputs implements core.Chainable: the new files, the same kind and
// extension as the inputs.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	files := make([]core.RunFile, 0, len(job.Outputs))
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		files = append(files, core.RunFile{Path: out.Path, Name: name, Kind: core.KindImage, OutputID: out.ID})
	}
	return core.StepResult{Files: files, Vars: map[string]string{}}, nil
}
