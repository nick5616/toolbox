// Package viz is the Go side of the Visualizer (SPEC.md §4.3): song analysis
// (engine features, words, mood), the render broker that streams video from
// the webview renderer over raw messages, and the FFmpeg mux/composite steps.
// Lyric Video and Subtitles use it for their visual backgrounds (§9).
//
// CONTRACT (foundation): the exported types and signatures here are frozen.
// AN2 implements analyze.go/meaning.go/cache.go/visuals.go; RB1 implements
// broker.go/mux.go/plan.go.
package viz

import "toolbox/core/lyrics"

// WordsSource is where the words of an analysis come from.
type WordsSource string

const (
	WordsNone   WordsSource = "none"
	WordsDetect WordsSource = "detect" // transcribe the vocals (or the mix)
	WordsAlign  WordsSource = "align"  // align pasted lyrics to the transcription
	WordsFile   WordsSource = "file"   // .lrc/.srt/.vtt (.txt = align)
	WordsGiven  WordsSource = "given"  // lines handed in by a tool (Lyric Video, Subtitles)
)

// Limits shared by Validate and the analysis.
const (
	MaxLyricsChars = 20_000
	MaxGivenLines  = 20_000
	MaxShowBytes   = 512 << 10
	MaxInputMs     = 60 * 60 * 1000 // inputs longer than 60 minutes are refused
)

// AnalyzeOptions say what an analysis computes (SPEC.md §4.3, §5.1).
type AnalyzeOptions struct {
	Stems      bool          `json:"stems"`      // separate instruments (Demucs 4-stem)
	SaveStems  bool          `json:"saveStems"`  // also write the 4 stems to the Library (§9.7)
	Words      WordsSource   `json:"words"`      // default none
	Language   string        `json:"language"`   // "" auto or a Transcribe code
	LyricsText string        `json:"lyricsText"` // align: ≤ 20,000 chars
	LyricsPath string        `json:"lyricsPath"` // file
	Lines      []lyrics.Line `json:"lines"`      // given: ≤ 20,000 lines
	Mood       bool          `json:"mood"`       // mood reader (default on with words)
	DeepRead   bool          `json:"deepRead"`   // also ask the Local Chat model
}

// AnalysisRef points at a finished analysis in the cache.
type AnalysisRef struct {
	Key          string          `json:"key"`          // "<file key>-s<0|1>-<text key>-m<0|1|2>"
	AudioJSON    string          `json:"audioJson"`    // absolute paths
	FeaturesPath string          `json:"featuresPath"` //
	TextJSON     string          `json:"textJson"`     // "" when Words = none
	Instrumental string          `json:"instrumental"` // "" without stems
	Summary      AnalysisSummary `json:"summary"`
}

// AnalysisSummary is what the UI shows about an analysis.
type AnalysisSummary struct {
	DurationMs int64    `json:"durationMs"`
	Tempo      float64  `json:"tempo"`
	Key        string   `json:"key"`      // "A minor"
	Sections   []string `json:"sections"` // labels in order
	HasStems   bool     `json:"hasStems"`
	HasWords   bool     `json:"hasWords"`
	HasMeaning bool     `json:"hasMeaning"`
	MoodSource string   `json:"moodSource"` // "music" | "reader" | "reader+chat" | "chat"
	Language   string   `json:"language"`
	Lines      int      `json:"lines"`
	Warnings   []string `json:"warnings"`
}

// RenderMode is how the renderer outputs frames.
type RenderMode string

const (
	ModeOpaque  RenderMode = "opaque"  // full frames
	ModeOverlay RenderMode = "overlay" // double-height colour-over-alpha frames
)

// RenderPlan is everything the webview renderer needs (paths become /media
// URLs when the plan is written for the worker).
type RenderPlan struct {
	Analysis  AnalysisRef `json:"analysis"`
	ShowJSON  string      `json:"showJson"` // ≤ 512 KiB; validated by the renderer
	Width     int         `json:"width"`    // even, 320..3840
	Height    int         `json:"height"`   // even, 320..3840 (opaque) / ≤ 1440 (overlay)
	FPS       int         `json:"fps"`      // 24 | 25 | 30 | 50 | 60
	StartMs   int64       `json:"startMs"`
	EndMs     int64       `json:"endMs"`
	Mode      RenderMode  `json:"mode"`
	CoverPath string      `json:"coverPath"` // optional texture
	ImagePath string      `json:"imagePath"` // optional still background texture
	Seed      int64       `json:"seed"`
}

// RenderOutput is the elementary stream the renderer produced in TempDir.
type RenderOutput struct {
	Path    string `json:"path"`
	Codec   string `json:"codec"` // "h264" | "mjpeg"
	Frames  int    `json:"frames"`
	Encoder string `json:"encoder"` // "h264-hw" | "h264-sw" | "jpeg"
}

// VisualsSpec is a design chosen for another tool's background (§9).
type VisualsSpec struct {
	ShowJSON string `json:"showJson"` // a preset or saved design (≤ 512 KiB)
	Stems    bool   `json:"stems"`    // separate instruments for the analysis
	UseWords bool   `json:"useWords"` // feed the tool's own timed text into the analysis
}

// RenderStart is the payload of the viz:render event.
type RenderStart struct {
	Token   string `json:"token"`
	PlanURL string `json:"planUrl"`
	JobID   string `json:"jobId"`
}

// RenderAck is the payload of the viz:render-ack event.
type RenderAck struct {
	Token string `json:"token"`
	Bytes int64  `json:"bytes"`
}

// RenderCancel is the payload of the viz:render-cancel event.
type RenderCancel struct {
	Token string `json:"token"`
}

// Event names (registered in api/events.go).
const (
	EventRender       = "viz:render"
	EventRenderAck    = "viz:render-ack"
	EventRenderCancel = "viz:render-cancel"
)

// RawPrefix starts every render message from the webview; LabPrefix starts
// VizLab messages (accepted only with TOOLBOX_VIZLAB=1).
const (
	RawPrefix = "vz1|"
	LabPrefix = "vzlab|"
)
