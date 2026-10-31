package visualizer

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2, §6.4).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD2 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are the Visualizer's pipeline step options; steps use the
// "auto" action (analyze, then render).
type StepOptions struct {
	PresetID   string `json:"presetId"`   // the preset it came from ("" = a saved design); a label only
	DesignName string `json:"designName"` // shown in the summary
	ShowJSON   string `json:"showJson"`   // required, ≤ 512 KiB
	Mode       Mode   `json:"mode"`       // full | overlay (overlay needs a video input)
	Aspect     string `json:"aspect"`
	Height     int    `json:"height"`
	FPS        int    `json:"fps"`
	Audio      string `json:"audio"`      // "original" | "instrumental" (needs Stems)
	Background string `json:"background"` // "none" | "cover"
	Stems      bool   `json:"stems"`
	SaveStems  bool   `json:"saveStems"`
	Words      string `json:"words"`    // "none" | "detect"
	Language   string `json:"language"` // words: "" = auto
	Mood       bool   `json:"mood"`
}

// DefaultStepOptions: full frame 16:9 1080p30 with stems and mood, no words;
// the design is picked in the step editor.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{Mode: o.Mode, Aspect: o.Aspect, Height: o.Height, FPS: o.FPS, Audio: o.Audio,
		Background: o.Background, Stems: true, Words: "none", Mood: true}
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
		Produces: []core.StepProduct{{Role: "video", Label: "Video", Kind: core.KindVideo, Exts: []string{".mp4"}}},
		Vars:     []core.StepVar{},
		Summary:  "Visualizer",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Visualizer as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Visualizer as a pipeline step")
}
