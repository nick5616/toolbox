package bgremove

import "regexp"

// Model selects a background-removal model preset.
type Model string

const (
	ModelFast     Model = "fast"
	ModelBalanced Model = "balanced"
	ModelBest     Model = "best"
)

// Output is what the job writes.
type Output string

const (
	OutputTransparent Output = "transparent" // RGBA cutout
	OutputColor       Output = "color"       // subject on a solid colour
	OutputMask        Output = "mask"        // greyscale mask only
)

// Padding bounds (px around a crop).
const (
	MinPadding = 0
	MaxPadding = 500
)

// HexColor matches "#rrggbb".
var HexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Options are the Background Remover's per-submission options.
type Options struct {
	Model      Model  `json:"model"`
	Output     Output `json:"output"`
	Color      string `json:"color"`      // "#rrggbb", used when Output is "color"
	Crop       bool   `json:"crop"`       // crop to the subject's bounds
	Padding    int    `json:"padding"`    // px around the crop, 0..500
	CleanEdges bool   `json:"cleanEdges"` // edge colour decontamination
	Refine     bool   `json:"refine"`     // guided-filter edge refinement
}

// DefaultOptions: balanced model, transparent PNG, clean edges.
func DefaultOptions() Options {
	return Options{Model: ModelBalanced, Output: OutputTransparent, Color: "#ffffff", Padding: 24, CleanEdges: true}
}

// Result is stored as the job's ResultJSON.
type Result struct {
	Width           int     `json:"width"`
	Height          int     `json:"height"`
	SubjectCoverage float64 `json:"subjectCoverage"` // 0..1 share of alpha > 127
	Model           Model   `json:"model"`
	Output          string  `json:"output"` // absolute path
}
