package midi

// Range limits the transcribed pitch range.
type Range string

const (
	RangeFull   Range = "full"
	RangeBass   Range = "bass"   // maxHz 400
	RangeMelody Range = "melody" // minHz 200
)

// Options are the Audio → MIDI per-submission options (SPEC.md §6.3).
type Options struct {
	// Sensitivity 0.1–0.9 maps to onsetThreshold = 1 - Sensitivity.
	Sensitivity float64 `json:"sensitivity"`
	// NoteFloor 0.1–0.6 is Basic Pitch's frameThreshold.
	NoteFloor float64 `json:"noteFloor"`
	// MinNoteMs 30–500 is the minimum note length.
	MinNoteMs    float64 `json:"minNoteMs"`
	Range        Range   `json:"range"`
	MelodiaTrick bool    `json:"melodiaTrick"`
}

// DefaultOptions mirror Basic Pitch's defaults.
func DefaultOptions() Options {
	return Options{Sensitivity: 0.5, NoteFloor: 0.3, MinNoteMs: 127.7, Range: RangeFull, MelodiaTrick: true}
}

// Result is stored as the job's ResultJSON.
type Result struct {
	Notes       int     `json:"notes"`
	PitchRange  [2]int  `json:"pitchRange"` // MIDI note numbers [lo, hi]
	DurationSec float64 `json:"durationSec"`
}
