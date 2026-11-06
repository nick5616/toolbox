package gif

// Mode is what the tool makes.
type Mode string

const (
	ModeGIF   Mode = "gif"   // a looping GIF
	ModeWebP  Mode = "webp"  // an animated WebP
	ModeSheet Mode = "sheet" // a contact sheet (JPG)
)

// Limits.
const (
	MaxLengthSec   = 30.0
	MinLengthSec   = 0.5
	MinFPS         = 1
	MaxFPS         = 30
	MinWidth       = 120
	MaxWidth       = 1280
	MinCellWidth   = 120
	MaxCellWidth   = 1280
	MaxGrid        = 10  // columns and rows each
	MaxTiles       = 100 // columns × rows
	MaxOutputBytes = 50 << 20
)

// Options are the tool's per-submission options.
type Options struct {
	Mode      Mode    `json:"mode"`
	StartSec  float64 `json:"startSec"`  // GIF/WebP: where the loop starts
	LengthSec float64 `json:"lengthSec"` // GIF/WebP: 0.5–30
	FPS       int     `json:"fps"`       // GIF/WebP: 1–30
	Width     int     `json:"width"`     // GIF/WebP: 120–1280 px (never upscaled)
	Loop      bool    `json:"loop"`      // GIF/WebP: loop forever (off = play once)
	Columns   int     `json:"columns"`   // sheet: 1–10
	Rows      int     `json:"rows"`      // sheet: 1–10, columns × rows ≤ 100
	CellWidth int     `json:"cellWidth"` // sheet: width of each frame, 120–1280 px
	Labels    bool    `json:"labels"`    // sheet: a timecode on each frame
}

// DefaultOptions: a 5 s, 12 fps, 480 px GIF that loops; a 4 × 4 sheet of 320 px frames with timecodes.
func DefaultOptions() Options {
	return Options{Mode: ModeGIF, StartSec: 0, LengthSec: 5, FPS: 12, Width: 480, Loop: true, Columns: 4, Rows: 4, CellWidth: 320, Labels: true}
}

// Result is a finished job's result.
type Result struct {
	Mode       Mode     `json:"mode"`
	Outputs    []string `json:"outputs"`
	SizeBytes  int64    `json:"sizeBytes"`
	DurationMs int64    `json:"durationMs"` // GIF/WebP: how long the loop is
	Frames     int      `json:"frames"`     // sheet: how many frames it shows
	Width      int      `json:"width"`
	Height     int      `json:"height"`
}
