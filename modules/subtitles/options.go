package subtitles

// Action is what one Subtitles job does (SPEC.md §5.1).
type Action string

const (
	ActionGenerate  Action = "generate"  // speech → cues (Whisper)
	ActionExtract   Action = "extract"   // a text subtitle stream → .srt
	ActionSave      Action = "save"      // cues → .srt/.vtt
	ActionTranslate Action = "translate" // cues → translated .srt (Local Chat)
	ActionBurn      Action = "burn"      // cues drawn into the video
	ActionEmbed     Action = "embed"     // cues added as a subtitle track
)

// Style is a burn-in look.
type Style string

const (
	StyleClassic Style = "classic"
	StyleBoxed   Style = "boxed"
	StyleYellow  Style = "yellow"
	StyleMinimal Style = "minimal"
)

// Cue is one subtitle. Text may contain "\n" (at most 2 lines).
type Cue struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
}

// Options are Subtitles' per-submission options. Each action reads only
// the fields it needs.
type Options struct {
	Action Action `json:"action"`
	// generate
	Model              string `json:"model"`    // "base" | "small" | "turbo" (Transcribe's presets)
	Language           string `json:"language"` // "" auto or a Transcribe language code
	TranslateToEnglish bool   `json:"translateToEnglish"`
	MaxLineChars       int    `json:"maxLineChars"` // 32–60
	MaxLines           int    `json:"maxLines"`     // 1 or 2
	// extract
	StreamIndex int `json:"streamIndex"`
	// save | translate | burn | embed
	Cues           []Cue    `json:"cues"`           // ≤ 20,000
	Formats        []string `json:"formats"`        // save: ≥ 1 of "srt", "vtt"
	SourceLanguage string   `json:"sourceLanguage"` // translate: code or ""
	TargetLanguage string   `json:"targetLanguage"` // translate: code from TranslationLanguages()
	Style          Style    `json:"style"`          // burn
	Size           string   `json:"size"`           // burn: "s" | "m" | "l"
	Position       string   `json:"position"`       // burn: "bottom" | "top"
	Font           string   `json:"font"`           // burn: from media.Fonts()
	TrackLanguage  string   `json:"trackLanguage"`  // embed: ISO 639-1 code or ""
}

// DefaultOptions: generate with Whisper small, auto language, 42 × 2 lines,
// SRT, classic medium bottom Arial.
func DefaultOptions() Options {
	return Options{
		Action: ActionGenerate, Model: "small", MaxLineChars: 42, MaxLines: 2,
		Cues: []Cue{}, Formats: []string{"srt"},
		Style: StyleClassic, Size: "m", Position: "bottom", Font: "Arial",
	}
}

// Language is a selectable language.
type Language struct {
	Code string `json:"code"` // ISO 639-1
	Name string `json:"name"`
}

// StyleInfo describes a burn-in style for the UI.
type StyleInfo struct {
	ID    Style  `json:"id"`
	Label string `json:"label"`
}

// TranslatorStatus says whether Local Chat can translate right now.
type TranslatorStatus struct {
	Ready bool   `json:"ready"`
	Model string `json:"model"` // the model that would be used
	Error string `json:"error"` // why not, when not ready
}

// Result is a job's result.
type Result struct {
	Action   Action   `json:"action"`
	Language string   `json:"language"` // generate: detected or chosen; translate: target
	Cues     int      `json:"cues"`
	Outputs  []string `json:"outputs"`
}
