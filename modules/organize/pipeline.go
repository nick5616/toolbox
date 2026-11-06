package organize

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"

	"toolbox/core"
)

var _ core.Chainable = (*Module)(nil)

// decodeStep decodes step options strictly over the defaults.
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
	return o, nil
}

func firstField(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	keys := make([]string, 0, len(ae.Fields))
	for k := range ae.Fields {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return core.ValidationError(ae.Fields[keys[0]], ae.Fields)
}

// stepProducts are the roles the step makes.
func stepProducts() []core.StepProduct {
	return []core.StepProduct{
		{Role: "file", Label: "Organized file", Many: true},
		{Role: "duplicate", Label: "Duplicate", Many: true},
		{Role: "report", Label: "Report", Kind: core.KindDocument, Exts: []string{".csv"}},
	}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if fields := optionFields(o); len(fields) > 0 {
		return core.StepInfo{}, firstField(core.ValidationError("Check the options", fields))
	}
	if o.Destination != "" {
		if _, serr := filepath.Abs(o.Destination); serr != nil {
			return core.StepInfo{}, core.ValidationError("Choose a folder", map[string]string{"destination": "Choose a folder"})
		}
	}
	summary := map[GroupBy]string{GroupDate: "By date taken", GroupType: "By type", GroupCamera: "By camera", GroupPattern: "Pattern " + o.Pattern}[o.GroupBy]
	switch o.Duplicates {
	case DupExact:
		summary += " · exact duplicates aside"
	case DupSimilar:
		summary += " · look-alikes aside"
	}
	return core.StepInfo{
		Accepts:   core.Accepts{Any: true},
		Produces:  stepProducts(),
		Vars:      []core.StepVar{{Name: "folder", Label: "Result folder", Type: core.ValueText}},
		Together:  true, // one result folder for the whole batch
		Secrets:   []core.StepSecret{},
		Templates: []string{},
		Warnings:  []string{},
		Summary:   summary,
	}, nil
}

// PrepareStep implements core.Chainable: every file of every merged item goes
// into one job.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	files := req.Item.Files
	if len(req.Items) > 0 {
		files = nil
		for _, it := range req.Items {
			files = append(files, it.Files...)
		}
	}
	var inputs []string
	for _, f := range files {
		if !slices.Contains(inputs, f.Path) {
			inputs = append(inputs, f.Path)
		}
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("There are no files to organize", nil)
	}
	if o.RunName == "" && req.Pipeline != "" {
		o.RunName = sanitizeComponent(req.Pipeline)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal organize options: %w", err)
	}
	if err := m.validate(inputs, raw); err != nil {
		return nil, firstField(err)
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// StepOutputs implements core.Chainable. The report names the run folder;
// files below its Duplicates folder are duplicates.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	root := ""
	for _, out := range job.Outputs {
		if filepath.Base(out.Path) == ReportName {
			root = filepath.Dir(out.Path)
		}
	}
	res.Vars["folder"] = root
	dups := filepath.Join(root, DuplicatesDir) + string(filepath.Separator)
	for _, out := range job.Outputs {
		role, label := "file", "Organized file"
		switch {
		case root != "" && out.Path == filepath.Join(root, ReportName):
			role, label = "report", "Report"
		case root != "" && len(out.Path) > len(dups) && pathKey(out.Path[:len(dups)]) == pathKey(dups):
			role, label = "duplicate", "Duplicate"
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID, Role: role, RoleLabel: label})
	}
	return res, nil
}
