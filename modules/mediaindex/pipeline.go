package mediaindex

import (
	"context"
	"encoding/json"

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

// PrepareStep implements core.Chainable.
func (m *FilterModule) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.Errorf(core.CodeNotImplemented, "This step isn't ready yet")
}

// StepOutputs implements core.Chainable.
func (m *FilterModule) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.Errorf(core.CodeNotImplemented, "This step isn't ready yet")
}
