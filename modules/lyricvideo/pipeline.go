package lyricvideo

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2, §6.4).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD2 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are Lyric Video's pipeline step options; steps use the "auto"
// action (detect the lyrics, then render). Look.Title and Look.Artist take
// {vars}.
type StepOptions struct {
	Language string `json:"language"`
	Look     Look   `json:"look"`
	Audio    string `json:"audio"`  // "original" | "instrumental"
	Aspect   string `json:"aspect"` // "16:9" | "9:16" | "1:1"
	Height   int    `json:"height"` // 720 | 1080
}

// DefaultStepOptions: the default look titled with the item's name.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	look := DefaultLook()
	look.Title = "{item}"
	return StepOptions{Language: o.Language, Look: look, Audio: o.Audio, Aspect: o.Aspect, Height: o.Height}
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
		Produces: []core.StepProduct{{Role: "video", Label: "Video", Kind: core.KindVideo, Exts: []string{".mp4"}}, {Role: "lyrics", Label: "Lyrics", Kind: core.KindOther, Exts: []string{".lrc"}}},
		Vars:     []core.StepVar{},
		Summary:  "Lyric Video",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Lyric Video as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Lyric Video as a pipeline step")
}
