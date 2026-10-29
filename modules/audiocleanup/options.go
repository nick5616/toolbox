package audiocleanup

// Denoise is the noise-reduction mode (SPEC.md §6.1).
type Denoise string

const (
	DenoiseOff    Denoise = "off"
	DenoiseLight  Denoise = "light"  // FFmpeg afftdn
	DenoiseStrong Denoise = "strong" // FFmpeg arnndn (RNNoise, embedded model)
	DenoiseVoice  Denoise = "voice"  // DeepFilterNet3 on the AI engine
)

// Hum is mains-hum removal.
type Hum string

const (
	HumOff  Hum = "off"
	HumAuto Hum = "auto"
	Hum50   Hum = "50"
	Hum60   Hum = "60"
)

// Loudness is the loudness target.
type Loudness string

const (
	LoudnessOff       Loudness = "off"
	LoudnessPodcast   Loudness = "podcast"   // −16 LUFS, −1.5 dBTP
	LoudnessStreaming Loudness = "streaming" // −14 LUFS, −1.0 dBTP
	LoudnessBroadcast Loudness = "broadcast" // −23 LUFS, −1.0 dBTP
)

// Format is the output format for audio inputs.
type Format string

const (
	FormatSame Format = "same"
	FormatWAV  Format = "wav"
	FormatFLAC Format = "flac"
	FormatMP3  Format = "mp3"
	FormatM4A  Format = "m4a"
)

// Options are Audio Cleanup's per-submission options.
type Options struct {
	HighPass       bool     `json:"highPass"` // 80 Hz rumble filter
	Hum            Hum      `json:"hum"`
	Denoise        Denoise  `json:"denoise"`
	Loudness       Loudness `json:"loudness"`
	Format         Format   `json:"format"`  // ignored for video inputs (container kept)
	Preview        bool     `json:"preview"` // 10 s A/B excerpt instead of the whole file
	PreviewStartMs int64    `json:"previewStartMs"`
}

// DefaultOptions: high-pass on, hum auto, voice isolation, podcast loudness,
// same format.
func DefaultOptions() Options {
	return Options{HighPass: true, Hum: HumAuto, Denoise: DenoiseVoice, Loudness: LoudnessPodcast, Format: FormatSame}
}

// FileResult is one cleaned file.
type FileResult struct {
	Input      string  `json:"input"`
	Output     string  `json:"output"`
	LUFSBefore float64 `json:"lufsBefore"`
	LUFSAfter  float64 `json:"lufsAfter"`
	HumHz      int     `json:"humHz"` // 0 = none removed
}

// Result is a job's result. Preview jobs fill the preview fields instead
// of Files.
type Result struct {
	Files           []FileResult `json:"files"`
	PreviewOriginal string       `json:"previewOriginal"`
	PreviewCleaned  string       `json:"previewCleaned"`
	LUFSBefore      float64      `json:"lufsBefore"`
	LUFSAfter       float64      `json:"lufsAfter"`
	HumHz           int          `json:"humHz"`
}
