package redact

// Action is what one Redact job does (SPEC.md §8.1).
type Action string

const (
	ActionDetect Action = "detect" // find faces/plates; result only
	ActionApply  Action = "apply"  // draw the given boxes
	ActionAuto   Action = "auto"   // detect + apply, no review
)

// Style is how a box is hidden.
type Style string

const (
	StyleBlur     Style = "blur"
	StylePixelate Style = "pixelate"
	StyleSolid    Style = "solid"
)

// Sensitivity picks the detection thresholds (face / plate):
// normal 0.6 / 0.3, high 0.45 / 0.2.
type Sensitivity string

const (
	SensitivityNormal Sensitivity = "normal"
	SensitivityHigh   Sensitivity = "high"
)

// Box is a region in 0..1 coordinates of the upright frame (EXIF- or
// display-rotated).
type Box struct {
	ID      string  `json:"id"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
	Kind    string  `json:"kind"` // "face" | "plate" | "manual"
	Enabled bool    `json:"enabled"`
	Score   float64 `json:"score"`
}

// TimedBox is a manual box in a video, shown between StartMs and EndMs.
type TimedBox struct {
	Box
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
}

// Options are Redact's per-submission options.
type Options struct {
	Action        Action      `json:"action"`
	Faces         bool        `json:"faces"`
	Plates        bool        `json:"plates"`
	Sensitivity   Sensitivity `json:"sensitivity"`
	Style         Style       `json:"style"`
	Strength      int         `json:"strength"`      // 1–10
	Padding       int         `json:"padding"`       // % added around each box, 0–50
	StripMetadata bool        `json:"stripMetadata"` // remove EXIF/XMP/IPTC (images), container metadata (video)
	// apply, images: input path → its boxes (only enabled ones are drawn)
	ImageBoxes map[string][]Box `json:"imageBoxes"`
	// apply, video
	DetectionsPath string     `json:"detectionsPath"`
	DisabledTracks []string   `json:"disabledTracks"`
	ManualBoxes    []TimedBox `json:"manualBoxes"`
}

// DefaultOptions: faces + plates, normal, blur 6, 15 % padding, strip
// metadata.
func DefaultOptions() Options {
	return Options{
		Action: ActionDetect, Faces: true, Plates: true, Sensitivity: SensitivityNormal,
		Style: StyleBlur, Strength: 6, Padding: 15, StripMetadata: true,
		ImageBoxes: map[string][]Box{}, DisabledTracks: []string{}, ManualBoxes: []TimedBox{},
	}
}

// ImageDetections are one image's detections.
type ImageDetections struct {
	Path   string `json:"path"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Boxes  []Box  `json:"boxes"`
}

// TrackSample is a track's box at one time (every 200 ms, for the UI).
type TrackSample struct {
	Ms int64   `json:"ms"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	W  float64 `json:"w"`
	H  float64 `json:"h"`
}

// Track is one followed face or plate in a video.
type Track struct {
	ID       string        `json:"id"`
	Kind     string        `json:"kind"` // "face" | "plate"
	StartMs  int64         `json:"startMs"`
	EndMs    int64         `json:"endMs"`
	MaxScore float64       `json:"maxScore"`
	Enabled  bool          `json:"enabled"` // default: false for likely false positives
	Samples  []TrackSample `json:"samples"`
}

// VideoDetections are a video's detections.
type VideoDetections struct {
	DetectionsPath string  `json:"detectionsPath"` // full-rate data for apply
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	DurationMs     int64   `json:"durationMs"`
	Tracks         []Track `json:"tracks"`
}

// Result is a job's result: detect fills Images or Video; apply/auto fill
// Outputs.
type Result struct {
	Action  Action            `json:"action"`
	Images  []ImageDetections `json:"images"`
	Video   *VideoDetections  `json:"video"`
	Outputs []string          `json:"outputs"`
}
