package trimmer

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2, §6.3).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD1 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepKeep says which part of each file a Trimmer step keeps.
type StepKeep string

const (
	KeepWhole StepKeep = "whole"
	KeepFirst StepKeep = "first" // the first Seconds
	KeepLast  StepKeep = "last"  // the last Seconds
	KeepRange StepKeep = "range" // From–To
)

// StepOptions are the Trimmer's pipeline step options: the part to keep is
// resolved per file at run time.
type StepOptions struct {
	Keep        StepKeep `json:"keep"`
	Seconds     float64  `json:"seconds"` // first/last: 1–36,000
	From        string   `json:"from"`    // range: timecode, "" = start
	To          string   `json:"to"`      // range: timecode, "" = end
	Mode        Mode     `json:"mode"`
	Aspect      Aspect   `json:"aspect"`
	CropX       float64  `json:"cropX"`
	CropY       float64  `json:"cropY"`
	MaxSizeMB   int      `json:"maxSizeMB"`
	MaxHeight   int      `json:"maxHeight"`
	RemoveAudio bool     `json:"removeAudio"`
}

// DefaultStepOptions: the whole file, precise, shape and size unchanged.
func DefaultStepOptions() StepOptions {
	return StepOptions{Keep: KeepWhole, Seconds: 30, Mode: ModePrecise, Aspect: AspectKeep, CropX: 0.5, CropY: 0.5}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	if _, err := core.DecodeOptionsJSON[StepOptions](options); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: []core.StepProduct{{}},
		Vars:     []core.StepVar{},
		Summary:  "Video Trimmer",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Video Trimmer as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Video Trimmer as a pipeline step")
}
