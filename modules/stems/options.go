package stems

// Preset selects a separation model.
type Preset string

const (
	PresetVocalsFast Preset = "vocals-fast"
	PresetVocalsBest Preset = "vocals-best"
	PresetFourFast   Preset = "four-fast"
	PresetFourBest   Preset = "four-best"
)

// Format is the output audio format.
type Format string

const (
	FormatWAV  Format = "wav"
	FormatFLAC Format = "flac"
	FormatMP3  Format = "mp3"
)

// Options are the Stem Splitter's per-submission options.
type Options struct {
	Preset Preset `json:"preset"`
	Format Format `json:"format"`
}

// DefaultOptions: 4 stems, fast, FLAC (lossless and about half the size of WAV).
func DefaultOptions() Options { return Options{Preset: PresetFourFast, Format: FormatFLAC} }
