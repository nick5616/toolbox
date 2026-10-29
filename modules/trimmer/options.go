package trimmer

// Mode is how segments are cut (SPEC.md §4.1).
type Mode string

const (
	ModeFast    Mode = "fast"    // stream copy, cuts on keyframes
	ModePrecise Mode = "precise" // re-encode, frame-accurate
)

// Join is how several segments are written.
type Join string

const (
	JoinMerge    Join = "merge"    // one file
	JoinSeparate Join = "separate" // a file per segment
)

// Aspect is the output frame (precise mode only).
type Aspect string

const (
	AspectKeep     Aspect = "keep"
	AspectPortrait Aspect = "9:16"
	AspectSquare   Aspect = "1:1"
	AspectFourFive Aspect = "4:5"
	AspectWide     Aspect = "16:9"
)

// Segment is one kept range in timeline ms.
type Segment struct {
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
}

// Options are the Video Trimmer's per-submission options.
type Options struct {
	Segments    []Segment `json:"segments"` // 1–50, sorted, non-overlapping, each ≥ 100 ms
	Mode        Mode      `json:"mode"`
	Join        Join      `json:"join"`
	Aspect      Aspect    `json:"aspect"`
	CropX       float64   `json:"cropX"`     // 0..1, centre of the crop window
	CropY       float64   `json:"cropY"`     // 0..1
	MaxSizeMB   int       `json:"maxSizeMB"` // 0 = none, else 1–4000
	MaxHeight   int       `json:"maxHeight"` // 0 = keep, or 2160/1440/1080/720/480
	RemoveAudio bool      `json:"removeAudio"`
}

// DefaultOptions: no segments (the UI fills one covering the file), fast,
// merge, keep, centred, no limits.
func DefaultOptions() Options {
	return Options{Segments: []Segment{}, Mode: ModeFast, Join: JoinMerge, Aspect: AspectKeep, CropX: 0.5, CropY: 0.5}
}

// Result is a finished trim's result.
type Result struct {
	Outputs []string `json:"outputs"`
	// MaxShiftMs is how far the largest fast-mode cut moved back to a
	// keyframe (0 in precise mode).
	MaxShiftMs int64 `json:"maxShiftMs"`
}
