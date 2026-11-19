package mediaindex

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"toolbox/core"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

// "Keep files that show…" (search-filter, SPEC.md §3.9). CONTRACT STUB
// (Wave 0): the options, Descriptor, StepDefaults and DescribeStep are final;
// S6 implements Validate/Run (filter.go), PrepareStep and StepOutputs.

// FilterMatch says what a file is matched by.
type FilterMatch string

const (
	MatchPicture FilterMatch = "picture"
	MatchText    FilterMatch = "text"
	MatchBoth    FilterMatch = "both"
)

// FilterStrength is the weakest match that counts.
type FilterStrength string

const (
	FilterStrong FilterStrength = "strong"
	FilterGood   FilterStrength = "good"
	FilterMaybe  FilterStrength = "maybe"
)

// FilterOptions are search-filter's options (job and step).
type FilterOptions struct {
	Query    string         `json:"query"` // template: takes {vars}
	Match    FilterMatch    `json:"match"`
	Strength FilterStrength `json:"strength"`
	Invert   bool           `json:"invert"` // keep the files that don't match
}

// DefaultFilterOptions are a new step's options.
func DefaultFilterOptions() FilterOptions {
	return FilterOptions{Query: "", Match: MatchBoth, Strength: FilterGood}
}

// Step file roles and variables.
const (
	RoleKept   = "kept"
	RoleOther  = "other"
	VarMatched = "matched"
	VarBest    = "best"
)

// Descriptor implements core.Module.
func (m *FilterModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ix.FilterModuleID, Name: "Keep files that show…", Icon: "scan-eye", Category: core.CategoryUtility,
		Tagline:     "Keep only the files whose picture or text matches a description",
		Description: "Sorts files by what's in them with Smart search: a dog, a receipt, a whiteboard, or words they contain.",
		Status:      core.StatusReady, Hidden: true, HiddenStep: true, Interactive: true,
		Accepts:  core.Accepts{Extensions: append(PictureExts(), SpeechExts()...)},
		Requires: []string{sidecar.DepID},
	}
}

// Validate implements core.Module.
func (m *FilterModule) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *FilterModule) Run(ctx context.Context, job *core.JobContext) error {
	return m.run(ctx, job)
}

var _ core.Chainable = (*FilterModule)(nil)

// StepDefaults implements core.Chainable.
func (m *FilterModule) StepDefaults() any { return DefaultFilterOptions() }

// DescribeStep implements core.Chainable.
func (m *FilterModule) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := core.DecodeOptionsJSON[FilterOptions](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	summary := "Keeps files showing “" + o.Query + "”"
	if o.Invert {
		summary = "Keeps files not showing “" + o.Query + "”"
	}
	if o.Query == "" {
		summary = "Describe what to keep"
	}
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		Produces: []core.StepProduct{
			{Role: RoleKept, Label: "Matching files", Many: true},
			{Role: RoleOther, Label: "Other files", Many: true},
		},
		Vars: []core.StepVar{
			{Name: VarMatched, Label: "How many matched", Type: core.ValueNumber},
			{Name: VarBest, Label: "Best label", Type: core.ValueText},
		},
		Templates: []string{"/query"},
		Summary:   summary,
	}, nil
}

// modelReady reports whether the vision model's files are installed.
func (m *FilterModule) modelReady() bool {
	if m.d.Writer == nil {
		return false
	}
	dir := m.d.Writer.Model().Dir
	if dir == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, "visual", "model.onnx"))
	return err == nil
}

// PrepareStep implements core.Chainable: one job with all the item's files.
func (m *FilterModule) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := filterOptions(req.Options)
	if err != nil {
		return nil, err
	}
	query, missing := core.ExpandVars(o.Query, req.Item.Vars)
	if len(missing) > 0 {
		msg := "The description uses {" + strings.Join(missing, "}, {") + "}, which no earlier step makes"
		return nil, core.ValidationError(msg, map[string]string{"query": msg})
	}
	o.Query = strings.TrimSpace(query)
	var inputs []string
	for _, f := range req.Item.Files {
		if !slices.Contains(inputs, f.Path) {
			inputs = append(inputs, f.Path)
		}
	}
	if len(inputs) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal filter options: %w", err)
	}
	if err := m.validate(inputs, raw); err != nil {
		return nil, err
	}
	if o.Match != MatchText && !m.modelReady() {
		return nil, core.ErrWaiting("Install Smart search to sort by content", "Open Settings, then Tool packs, and install Smart search")
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// StepOutputs implements core.Chainable: the job's result as kept/other files.
func (m *FilterModule) StepOutputs(job core.Job) (core.StepResult, error) {
	var res filterResult
	if err := json.Unmarshal([]byte(job.ResultJSON), &res); err != nil {
		return core.StepResult{}, fmt.Errorf("reading the filter result: %w", err)
	}
	other := res.Other
	if other == nil { // dropped to fit the result size: everything not kept
		kept := make(map[string]bool, len(res.Kept))
		for _, p := range res.Kept {
			kept[p] = true
		}
		for _, p := range job.Inputs {
			if !kept[p] {
				other = append(other, p)
			}
		}
	}
	out := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{
		VarMatched: strconv.Itoa(res.Matched),
		VarBest:    res.Best,
	}}
	add := func(paths []string, role, label string) {
		for _, p := range paths {
			out.Files = append(out.Files, core.RunFile{Path: p, Name: filepath.Base(p), Role: role, RoleLabel: label})
		}
	}
	add(res.Kept, RoleKept, "Matching files")
	add(other, RoleOther, "Other files")
	return out, nil
}
