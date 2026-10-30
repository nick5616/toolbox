package visualizer

import "toolbox/core/viz"

// Action is what one Visualizer job does (SPEC.md §10).
type Action string

const (
	ActionAnalyze Action = "analyze" // song analysis into the cache
	ActionRender  Action = "render"  // the video into the Library
	ActionPreview Action = "preview" // a 10 s render into the cache
)

// Mode is full-frame visuals or visuals over the input video.
type Mode string

const (
	ModeFull    Mode = "full"
	ModeOverlay Mode = "overlay"
)

// Options are the Visualizer's per-submission options.
type Options struct {
	Action         Action             `json:"action"`
	Analyze        viz.AnalyzeOptions `json:"analyze"`        // analyze
	AnalysisKey    string             `json:"analysisKey"`    // render/preview
	ShowJSON       string             `json:"showJson"`       // ≤ 512 KiB
	Mode           Mode               `json:"mode"`           //
	Aspect         string             `json:"aspect"`         // "16:9" | "9:16" | "1:1" | "4:5" (full)
	Height         int                `json:"height"`         // 720 | 1080 | 1440 | 2160 (short side, full)
	FPS            int                `json:"fps"`            // 30 | 60 (full)
	StartMs        int64              `json:"startMs"`        // 0 = start
	EndMs          int64              `json:"endMs"`          // 0 = end
	Audio          string             `json:"audio"`          // "original" | "instrumental"
	Background     string             `json:"background"`     // "none" | "cover" | "image" | "video" (full)
	BackgroundPath string             `json:"backgroundPath"` //
	PreviewStartMs int64              `json:"previewStartMs"` //
	Seed           int64              `json:"seed"`           //
}

// DefaultOptions: analyze with stems and the mood reader; render full 16:9
// 1080p30 with the original audio and no extra background.
func DefaultOptions() Options {
	return Options{
		Action:  ActionAnalyze,
		Analyze: viz.AnalyzeOptions{Stems: true, Words: viz.WordsNone, Mood: true, Lines: nil},
		Mode:    ModeFull, Aspect: "16:9", Height: 1080, FPS: 30,
		Audio: "original", Background: "none",
	}
}

// Result is a job's result.
type Result struct {
	Action      Action           `json:"action"`
	Analysis    *viz.AnalysisRef `json:"analysis"`    // analyze
	PreviewPath string           `json:"previewPath"` // preview
	Outputs     []string         `json:"outputs"`     // render
	Encoder     string           `json:"encoder"`     //
	Speed       float64          `json:"speed"`       // media seconds per wall second
}

// ChatStatus says whether a Local Chat model is ready for Deeper reading.
type ChatStatus struct {
	Model string `json:"model"`
	Ready bool   `json:"ready"`
}
