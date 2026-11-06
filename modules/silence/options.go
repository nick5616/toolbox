package silence

// Options are the Silence Cutter's per-submission options.
type Options struct {
	ThresholdDb  float64 `json:"thresholdDb"`  // -80..-10: quieter than this counts as silence
	MinSilenceMs int     `json:"minSilenceMs"` // 100..10,000: shorter quiet stretches are kept
	PaddingMs    int     `json:"paddingMs"`    // 0..2,000: kept on each side of a cut
	CrossfadeMs  int     `json:"crossfadeMs"`  // 0..200: smoothing at every join
	CutList      bool    `json:"cutList"`      // also write a .csv of kept and removed ranges
}

// Limits of Options.
const (
	MinThresholdDb  = -80.0
	MaxThresholdDb  = -10.0
	MinMinSilenceMs = 100
	MaxMinSilenceMs = 10_000
	MaxPaddingMs    = 2000
	MaxCrossfadeMs  = 200
)

// DefaultOptions: -35 dB, half a second, 150 ms of padding, a 15 ms smooth join.
func DefaultOptions() Options {
	return Options{ThresholdDb: -35, MinSilenceMs: 500, PaddingMs: 150, CrossfadeMs: 15, CutList: true}
}

// Range is a stretch of the file in milliseconds.
type Range struct {
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
}

// Analysis is what a quick look at a file finds (Service.Analyse).
type Analysis struct {
	DurationMs int64   `json:"durationMs"`
	Silences   []Range `json:"silences"` // as detected, before padding
	Removed    []Range `json:"removed"`  // what a cut would drop
	Kept       []Range `json:"kept"`
	RemovedMs  int64   `json:"removedMs"`
	KeptMs     int64   `json:"keptMs"`
}

// Result is a finished cut's result.
type Result struct {
	Output     string  `json:"output"`
	CutList    string  `json:"cutList"` // "" when not written
	DurationMs int64   `json:"durationMs"`
	RemovedMs  int64   `json:"removedMs"`
	KeptMs     int64   `json:"keptMs"`
	Removed    []Range `json:"removed"`
}
