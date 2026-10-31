package subtitles

import (
	"context"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/viz"
)

// Pipeline step adapter (SPEC.md §6.2, §6.4).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD2 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are Subtitles' pipeline step options; steps use the "auto"
// action (generate, translate, then save, burn or embed in one job).
type StepOptions struct {
	Model              string           `json:"model"`
	Language           string           `json:"language"`
	TranslateToEnglish bool             `json:"translateToEnglish"` // Whisper's own translation
	TargetLanguage     string           `json:"targetLanguage"`     // "" = keep; else via Local Chat
	MaxLineChars       int              `json:"maxLineChars"`
	MaxLines           int              `json:"maxLines"`
	Save               []string         `json:"save"`  // "srt", "vtt" (0–2)
	Video              string           `json:"video"` // "none" | "burn" | "embed"
	Style              Style            `json:"style"`
	Size               string           `json:"size"`
	Position           string           `json:"position"`
	Font               string           `json:"font"`
	TrackLanguage      string           `json:"trackLanguage"`
	MaxSizeMB          int              `json:"maxSizeMB"`
	Canvas             string           `json:"canvas"` // audio input + burn
	CanvasHeight       int              `json:"canvasHeight"`
	Background         string           `json:"background"` // "color" | "image" | "visualizer"
	BackgroundColor    string           `json:"backgroundColor"`
	BackgroundPath     string           `json:"backgroundPath"`
	Visuals            *viz.VisualsSpec `json:"visuals"`
}

// DefaultStepOptions: generate with the small model, save an SRT, burn it in.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{
		Model: o.Model, Language: o.Language, MaxLineChars: o.MaxLineChars, MaxLines: o.MaxLines,
		Save: []string{"srt"}, Video: VideoBurn, Style: o.Style, Size: o.Size, Position: o.Position,
		Font: o.Font, Canvas: o.Canvas, CanvasHeight: o.CanvasHeight, Background: o.Background,
		BackgroundColor: o.BackgroundColor,
	}
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
		Produces: []core.StepProduct{{Role: "subtitles", Label: "Subtitles", Kind: core.KindOther, Exts: []string{".srt"}, Many: true}, {Role: "video", Label: "Video", Kind: core.KindVideo, Exts: []string{".mp4"}}},
		Vars:     []core.StepVar{{Name: "subtitles", Label: "Subtitle text"}, {Name: "language", Label: "Language"}},
		Summary:  "Subtitles",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Subtitles as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Subtitles as a pipeline step")
}
