package captions

import (
	"context"
	"encoding/json"
	"path/filepath"
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

// PrepareStep implements core.Chainable: one caption job per item (or one
// for all merged items), with {vars} expanded in the context.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := core.DecodeOptionsJSON[Options](req.Options)
	if err != nil {
		return nil, err
	}
	if o.Model == "" {
		if _, err := m.visionModel(); err != nil {
			return nil, core.ErrWaiting("Install the Caption Writer pack", "Caption Writer needs a vision model; install the Caption Writer pack")
		}
	}
	items := req.Items
	if len(items) == 0 {
		items = []core.StepItem{req.Item}
	}
	var files []string
	var vars []map[string]string
	for _, it := range items {
		for _, f := range it.Files {
			files = append(files, f.Path)
		}
		vars = append(vars, it.Vars)
		if len(it.Files) > 0 {
			vars = append(vars, core.FileVars(it.Files[0]))
		}
	}
	if len(files) == 0 {
		return []core.StepJob{}, nil
	}
	o.Action, o.Batch, o.Index = ActionCaption, "", -1
	o.Context, _ = core.ExpandVars(o.Context, vars...)
	if r := []rune(o.Context); len(r) > MaxContext {
		o.Context = string(r[:MaxContext])
	}
	if o.Notes == nil {
		o.Notes = map[string]string{}
	}
	var jobs []core.StepJob
	for start := 0; start < len(files); start += MaxInputs {
		jobs = append(jobs, core.StepJob{Inputs: files[start:min(start+MaxInputs, len(files))], Options: o})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable: captions.csv as the table, the
// copies as "captioned", and the first file's texts as variables.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, v := range StepVars() {
		res.Vars[v.Name] = ""
	}
	label := "Copies with captions"
	if o, err := core.DecodeOptionsJSON[Options](json.RawMessage(job.OptionsJSON)); err == nil && o.Then == ThenRenameCopies {
		label = "Renamed copies"
	}
	var batchFile string
	for _, out := range job.Outputs {
		rf := core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID}
		switch {
		case strings.EqualFold(filepath.Base(out.Path), CSVFile):
			rf.Role, rf.RoleLabel = RoleTable, "Captions table"
		case strings.EqualFold(filepath.Base(out.Path), BatchFile):
			batchFile = out.Path
			continue
		default:
			rf.Role, rf.RoleLabel = RoleCaptioned, label
		}
		res.Files = append(res.Files, rf)
	}
	if batchFile != "" {
		if b, err := readBatchFile(filepath.Dir(batchFile)); err == nil && len(b.Items) > 0 {
			f := b.Items[0].Fields
			res.Vars["alt"], res.Vars["caption"] = f.Alt, f.Caption
			res.Vars["hashtags"] = strings.Join(f.Hashtags, " ")
			res.Vars["title"], res.Vars["description"] = f.Title, f.Description
			res.Vars["keywords"] = strings.Join(f.Keywords, ", ")
			res.Vars["name"] = f.Name
		}
	}
	return res, nil
}
