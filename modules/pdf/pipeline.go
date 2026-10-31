package pdf

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

// Pipeline step adapter (SPEC.md §6.2, §6.3).

var _ core.Chainable = (*Module)(nil)

// StepOptions are PDF Toolkit's pipeline step options. Organize and range
// splits need one specific document, so they aren't offered.
type StepOptions struct {
	Action      Action `json:"action"` // merge | split | compress | images-to-pdf | pdf-to-images | protect | unlock
	Every       int    `json:"every"`  // split: pages per file, ≥ 1
	Level       string `json:"level"`
	PageSize    string `json:"pageSize"`
	Margin      string `json:"margin"`
	ImageFormat string `json:"imageFormat"`
	DPI         int    `json:"dpi"`
}

// DefaultStepOptions mirrors DefaultOptions (merge).
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{Action: o.Action, Every: o.Every, Level: o.Level, PageSize: o.PageSize,
		Margin: o.Margin, ImageFormat: o.ImageFormat, DPI: o.DPI}
}

// stepActions are the actions a pipeline step offers.
var stepActions = []Action{ActionMerge, ActionSplit, ActionCompress, ActionImagesToPDF,
	ActionPDFToImages, ActionProtect, ActionUnlock}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// decodeStep decodes step options strictly over the defaults, so a partial
// object keeps the default for every field it leaves out.
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

// toOptions maps the step options onto the module's job options.
func (o StepOptions) toOptions() Options {
	full := DefaultOptions()
	full.Action = o.Action
	full.Every = o.Every
	full.Level = o.Level
	full.PageSize = o.PageSize
	full.Margin = o.Margin
	full.ImageFormat = o.ImageFormat
	full.DPI = o.DPI
	return full
}

// checkStep validates the fields the chosen action uses.
func checkStep(o StepOptions) error {
	if !slices.Contains(stepActions, o.Action) {
		if validAction(o.Action) {
			return fieldErr("action", "That action needs one specific document; it can't run in a pipeline")
		}
		return fieldErr("action", fmt.Sprintf("Unknown action %q", o.Action))
	}
	switch o.Action {
	case ActionSplit, ActionCompress, ActionImagesToPDF, ActionPDFToImages:
		// checkOptions only reads the secret store for protect/unlock.
		return new(Module).checkOptions(o.toOptions())
	}
	return nil
}

func pageWord(n int) string {
	if n == 1 {
		return "page"
	}
	return "pages"
}

// stepSummary is the one-line description of a step.
func stepSummary(o StepOptions) string {
	switch o.Action {
	case ActionMerge:
		return "Merge into one PDF"
	case ActionSplit:
		return fmt.Sprintf("Split every %d %s", o.Every, pageWord(o.Every))
	case ActionCompress:
		return "Compress · " + o.Level
	case ActionImagesToPDF:
		size := map[string]string{PageA4: "A4", PageLetter: "Letter", PageFit: "fit to image"}[o.PageSize]
		return "Photos → PDF · " + size
	case ActionPDFToImages:
		return fmt.Sprintf("Pages → %s · %d dpi", strings.ToUpper(o.ImageFormat), o.DPI)
	case ActionProtect:
		return "Add a password"
	case ActionUnlock:
		return "Remove the password"
	}
	return "PDF Toolkit"
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
	info := core.StepInfo{
		Accepts:   core.Accepts{Extensions: []string{".pdf"}},
		Vars:      []core.StepVar{},
		Secrets:   []core.StepSecret{},
		Templates: []string{},
		Warnings:  []string{},
		Summary:   stepSummary(o),
	}
	product := core.StepProduct{Role: "pdf", Label: "PDF", Kind: core.KindDocument, Exts: []string{".pdf"}}
	switch o.Action {
	case ActionMerge:
		info.Together = true
	case ActionImagesToPDF:
		info.Together = true
		info.Accepts = core.Accepts{Extensions: slices.Clone(ImageExtensions)}
	case ActionSplit:
		product.Many = true
	case ActionPDFToImages:
		product = core.StepProduct{Role: "page", Label: "Page", Kind: core.KindImage,
			Exts: []string{"." + o.ImageFormat}, Many: true}
	case ActionProtect:
		info.Secrets = []core.StepSecret{{Key: "password", Label: "New PDF password"}}
	case ActionUnlock:
		info.Secrets = []core.StepSecret{{Key: "password", Label: "PDF password"}}
	}
	info.Produces = []core.StepProduct{product}
	return info, nil
}

// PrepareStep implements core.Chainable.
//
// Merge and images-to-pdf make one job over every merged item's files, in
// order. A merge of a single PDF returns no jobs at all: the runner passes
// the input through unchanged (Merge itself needs two PDFs). Every other
// action makes one job per file. Passwords go into the module's in-memory
// secret store; the job options carry only the passwordRef.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	so, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := checkStep(so); err != nil {
		return nil, err
	}
	opts := so.toOptions()
	together := so.Action == ActionMerge || so.Action == ActionImagesToPDF

	files := req.Item.Files
	if together && len(req.Items) > 0 {
		files = nil
		for _, it := range req.Items {
			files = append(files, it.Files...)
		}
	}
	paths := make([]string, 0, len(files))
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	if len(paths) == 0 {
		return nil, fieldErr("inputs", "Add at least one file")
	}
	if so.Action == ActionMerge && len(paths) == 1 {
		if err := checkInputs(ActionSplit, paths); err != nil { // kind and size checks only
			return nil, err
		}
		return []core.StepJob{}, nil
	}
	if err := checkInputs(so.Action, paths); err != nil {
		return nil, err
	}

	password, newPassword := "", ""
	switch so.Action {
	case ActionProtect:
		if newPassword = req.Secrets["password"]; newPassword == "" {
			return nil, fieldErr("password", "Enter a password to protect the PDF with")
		}
	case ActionUnlock:
		if password = req.Secrets["password"]; password == "" {
			return nil, fieldErr("password", "Enter the PDF's password")
		}
	}
	if err := m.checkDocuments(ctx, paths, opts, password); err != nil {
		return nil, err
	}

	var groups [][]string
	if together {
		groups = [][]string{paths}
	} else {
		for _, p := range paths {
			groups = append(groups, []string{p})
		}
	}
	if password != "" || newPassword != "" {
		ref := m.state.sec.put(password, newPassword)
		m.state.sec.setJobs(ref, len(groups))
		opts.PasswordRef = ref
	}
	jobs := make([]core.StepJob, 0, len(groups))
	for _, g := range groups {
		jobs = append(jobs, core.StepJob{Inputs: g, Options: opts})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable. A compress that found nothing to
// shrink ("Already compact") registers no output: its input passes through.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	var o Options
	if job.OptionsJSON != "" {
		if err := json.Unmarshal([]byte(job.OptionsJSON), &o); err != nil {
			return core.StepResult{}, fmt.Errorf("read pdf job options: %w", err)
		}
	}
	role, label := "pdf", "PDF"
	if o.Action == ActionPDFToImages {
		role, label = "page", "Page"
	}
	files := make([]core.RunFile, 0, len(job.Outputs))
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		files = append(files, core.RunFile{Path: out.Path, Name: name, Kind: out.Kind,
			Role: role, RoleLabel: label, OutputID: out.ID})
	}
	if len(files) == 0 && o.Action == ActionCompress {
		for _, in := range job.Inputs {
			files = append(files, core.RunFile{Path: in, Name: filepath.Base(in), Kind: core.KindDocument,
				Role: role, RoleLabel: label})
		}
	}
	return core.StepResult{Files: files, Vars: map[string]string{}}, nil
}
