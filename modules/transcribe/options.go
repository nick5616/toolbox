package transcribe

// Model selects a Whisper model size.
type Model string

const (
	ModelBase  Model = "base"
	ModelSmall Model = "small"
	ModelTurbo Model = "turbo"
)

// Task is transcribe (keep the spoken language) or translate (to English).
type Task string

const (
	TaskTranscribe Task = "transcribe"
	TaskTranslate  Task = "translate"
)

// Output formats.
const (
	FormatTXT  = "txt"
	FormatSRT  = "srt"
	FormatVTT  = "vtt"
	FormatJSON = "json"
)

// AllFormats lists the output formats in UI order.
func AllFormats() []string { return []string{FormatTXT, FormatSRT, FormatVTT, FormatJSON} }

// Options are Transcribe's per-submission options.
type Options struct {
	Model    Model    `json:"model"`
	Language string   `json:"language"` // "" = auto-detect, else a code from Languages()
	Task     Task     `json:"task"`
	Formats  []string `json:"formats"` // ≥ 1 of AllFormats()
	VAD      bool     `json:"vad"`     // skip silence
}

// DefaultOptions: small model, auto language, TXT + SRT, skip silence.
func DefaultOptions() Options {
	return Options{Model: ModelSmall, Language: "", Task: TaskTranscribe, Formats: []string{FormatTXT, FormatSRT}, VAD: true}
}

// Language is a selectable spoken language.
type Language struct {
	Code string `json:"code"` // ISO-639-1
	Name string `json:"name"`
}

// Languages lists the languages offered in the UI (Whisper supports more;
// these are the common ones), sorted by name.
func Languages() []Language {
	return []Language{
		{"ar", "Arabic"}, {"ca", "Catalan"}, {"zh", "Chinese"}, {"cs", "Czech"}, {"da", "Danish"},
		{"nl", "Dutch"}, {"en", "English"}, {"fi", "Finnish"}, {"fr", "French"}, {"de", "German"},
		{"el", "Greek"}, {"he", "Hebrew"}, {"hi", "Hindi"}, {"hu", "Hungarian"}, {"id", "Indonesian"},
		{"it", "Italian"}, {"ja", "Japanese"}, {"ko", "Korean"}, {"ms", "Malay"}, {"no", "Norwegian"},
		{"fa", "Persian"}, {"pl", "Polish"}, {"pt", "Portuguese"}, {"ro", "Romanian"}, {"ru", "Russian"},
		{"es", "Spanish"}, {"sv", "Swedish"}, {"th", "Thai"}, {"tr", "Turkish"}, {"uk", "Ukrainian"},
		{"vi", "Vietnamese"},
	}
}

// Result is stored as the job's ResultJSON.
type Result struct {
	Language            string   `json:"language"` // ISO code detected or chosen
	LanguageProbability float64  `json:"languageProbability"`
	DurationSec         float64  `json:"durationSec"`
	Segments            int      `json:"segments"`
	Words               int      `json:"words"`
	Outputs             []string `json:"outputs"` // absolute paths
}
