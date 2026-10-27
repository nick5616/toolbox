package bpmkey

// Options are empty: analysis has no settings in Phase 2.
type Options struct{}

// Result is stored as the job's ResultJSON (mirrors the sidecar's
// analysis.bpm_key result, minus rssBytes).
type Result struct {
	BPM           float64        `json:"bpm"`
	BPMCandidates []float64      `json:"bpmCandidates"`
	Key           string         `json:"key"`     // e.g. "A minor"
	Camelot       string         `json:"camelot"` // e.g. "8A"
	Confidence    float64        `json:"confidence"`
	Alternatives  []KeyCandidate `json:"alternatives"`
	DurationSec   float64        `json:"durationSec"`
	Truncated     bool           `json:"truncated"`
}

// KeyCandidate is an alternative key estimate.
type KeyCandidate struct {
	Key     string  `json:"key"`
	Camelot string  `json:"camelot"`
	R       float64 `json:"r"`
}
