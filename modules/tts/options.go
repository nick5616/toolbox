package tts

// Split chooses how a long text becomes files.
type Split string

const (
	SplitNone     Split = "none"     // one file
	SplitHeadings Split = "headings" // one file per Markdown heading (chapter)
)

// Format is the audio file type written.
type Format string

const (
	FormatMP3 Format = "mp3"
	FormatM4A Format = "m4a"
	FormatWAV Format = "wav"
)

// Speed bounds (Kokoro's range).
const (
	MinSpeed = 0.5
	MaxSpeed = 2.0
)

// Options are Text to Speech's per-submission options.
type Options struct {
	Voice   string  `json:"voice"`   // a Voices() id, e.g. "af_heart"
	Speed   float64 `json:"speed"`   // 0.5..2.0
	Split   Split   `json:"split"`   // none | headings
	Format  Format  `json:"format"`  // mp3 | m4a | wav
	Preview bool    `json:"preview"` // speak one sample sentence into the preview cache (no output file)
}

// DefaultOptions: the "Heart" voice at normal speed, one MP3.
func DefaultOptions() Options {
	return Options{Voice: DefaultVoice, Speed: 1, Split: SplitNone, Format: FormatMP3}
}

// FileResult is one spoken file.
type FileResult struct {
	Path    string  `json:"path"`
	Title   string  `json:"title"` // chapter title, "" for a single file
	Seconds float64 `json:"seconds"`
	Chapter bool    `json:"chapter"`
}

// Result is stored as the job's ResultJSON.
type Result struct {
	Files       []FileResult `json:"files"`
	Seconds     float64      `json:"seconds"`
	Voice       string       `json:"voice"`
	PreviewPath string       `json:"previewPath"` // set for a preview job
}

// StepOptions are Text to Speech's pipeline step options (no preview).
type StepOptions struct {
	Voice  string  `json:"voice"`
	Speed  float64 `json:"speed"`
	Split  Split   `json:"split"`
	Format Format  `json:"format"`
}

// DefaultStepOptions mirrors DefaultOptions.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{Voice: o.Voice, Speed: o.Speed, Split: o.Split, Format: o.Format}
}

func (s StepOptions) toOptions() Options {
	return Options{Voice: s.Voice, Speed: s.Speed, Split: s.Split, Format: s.Format}
}
