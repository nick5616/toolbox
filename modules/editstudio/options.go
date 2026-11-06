package editstudio

import (
	"toolbox/core/lyrics"
	"toolbox/core/viz"
	"toolbox/modules/videoeditor"
)

// Job options, requests and results (SPEC.md §7, §10.5, §11.2). FROZEN after
// Wave 0.

// Action is what one Edit Studio job does.
type Action string

const (
	ActionAnalyze Action = "analyze" // song analysis (viz.Analyzer) for a project
	ActionPrepare Action = "prepare" // preview streams, shots, preview images for source paths
	ActionInterp  Action = "interp"  // interpolated slow-motion stream for a range
	ActionMatte   Action = "matte"   // a clip's matte
	ActionRender  Action = "render"  // the export into <library>/Edits
	ActionText    Action = "text"    // markers CSV/JSON or captions SRT into <library>/Edits

	// Pipeline steps (Phase 14 A2): both build an edit in memory and export it.
	ActionAssemble Action = "assemble" // "Assemble a video" (Video Editor): the inputs laid end to end, or into a template
	ActionBeat     Action = "beat"     // "Cut to the beat" (Edit Studio): a song plus clips, filled by a recipe
)

// Options are the job options.
type Options struct {
	Action    Action           `json:"action"`
	ProjectID string           `json:"projectId"`
	Analyze   *AnalyzeRequest  `json:"analyze"`
	Prepare   *PrepareRequest  `json:"prepare"`
	Interp    *InterpRequest   `json:"interp"`
	Matte     *MatteRequest    `json:"matte"`
	Text      *TextRequest     `json:"text"`
	Assemble  *AssembleRequest `json:"assemble"`
	Beat      *BeatRequest     `json:"beat"`
}

// AnalyzeRequest analyses a project's song (stems on, mood off).
type AnalyzeRequest struct {
	Song       string          `json:"song"`
	Words      viz.WordsSource `json:"words"`      // "none" | "detect" | "align"
	LyricsText string          `json:"lyricsText"` // align: ≤ viz.MaxLyricsChars
	Language   string          `json:"language"`   // "" = auto
}

// PrepareRequest makes preview streams, shots and preview images.
type PrepareRequest struct {
	Paths []string `json:"paths"` // 1..300
	FPS   int      `json:"fps"`   // 30 | 60
}

// InterpRequest makes an interpolated slow-motion stream (≤ 30 s).
type InterpRequest struct {
	Path   string `json:"path"`
	FromMs int64  `json:"fromMs"`
	ToMs   int64  `json:"toMs"`
	FPS    int    `json:"fps"`
}

// TextRequest writes a markers or captions file into the Library.
type TextRequest struct {
	Kind    string        `json:"kind"`    // "markers-csv" | "markers-json" | "srt"
	Name    string        `json:"name"`    // file stem (cleaned like project names)
	Markers []MarkerRow   `json:"markers"` // ≤ 20,000
	Cues    []lyrics.Line `json:"cues"`    // srt: timeline ms, ≤ 20,000
	Meta    string        `json:"meta"`    // markers-json header {project, song, startMs, endMs, fps} as JSON
}

// Text kinds.
const (
	TextMarkersCSV  = "markers-csv"
	TextMarkersJSON = "markers-json"
	TextSRT         = "srt"
)

// MarkerRow is one exported marker (SPEC.md §5.6).
type MarkerRow struct {
	Lane       string  `json:"lane"`
	TimelineMs int64   `json:"timelineMs"`
	SongMs     int64   `json:"songMs"`
	EndMs      int64   `json:"endMs"` // timeline ms; 0 = a point
	Strength   float64 `json:"strength"`
	Label      string  `json:"label"`
	Bar        int     `json:"bar"`
	Beat       int     `json:"beat"`
}

// EditStream is an Annex-B H.264 edit stream and its frame index (§7.1, §7.2).
type EditStream struct {
	Stream string `json:"stream"` // absolute paths (the UI asks MediaService.URLFor)
	Index  string `json:"index"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	FPS    int    `json:"fps"`
	Frames int    `json:"frames"`
}

// SourceState is what exists for one source file (§7.6).
type SourceState struct {
	Path      string               `json:"path"`
	Info      videoeditor.ClipInfo `json:"info"`      // kind, duration, size, fps, rotation, hasAudio, takenAt, error
	Preview   *EditStream          `json:"preview"`   // video, at the project fps
	Image     string               `json:"image"`     // photo: preview edit image
	Shots     []int64              `json:"shots"`     // video; nil = not made
	Preparing bool                 `json:"preparing"` // a prepare job for this path is queued/running
	Error     string               `json:"error"`
}

// MatteRequest makes a clip's matte (§10.5).
type MatteRequest struct {
	ClipID  string       `json:"clipId"`
	MatteID string       `json:"matteId"` // made by the UI and stored in clip.matte.id at submit
	Mode    string       `json:"mode"`    // "people" | "select" | "image"
	Path    string       `json:"path"`
	FromMs  int64        `json:"fromMs"` // the clip's source range (the UI computes it with the speed curve)
	ToMs    int64        `json:"toMs"`
	Clicks  []MatteClick `json:"clicks"`  // select
	Preview bool         `json:"preview"` // select: one-frame preview at Clicks[0].Ms
}

// Matte modes.
const (
	MattePeople = "people"
	MatteSelect = "select"
	MatteImage  = "image"
)

// MatteState says whether a matte's files exist (§10.5).
type MatteState struct {
	ID      string      `json:"id"`
	Ready   bool        `json:"ready"`
	FromMs  int64       `json:"fromMs"` // the range the files cover (video)
	ToMs    int64       `json:"toMs"`
	Preview *EditStream `json:"preview"` // video
	Export  *EditStream `json:"export"`
	Image   string      `json:"image"` // image mattes
}

// MatteModels says which cut-out models are installed.
type MatteModels struct {
	People          bool `json:"people"`
	Select          bool `json:"select"`
	Image           bool `json:"image"`
	SelectAvailable bool `json:"selectAvailable"` // false where SAM 2 can't run (§10.4)
}

// Result is a job's result.
type Result struct {
	Action   Action           `json:"action"`
	Analysis *viz.AnalysisRef `json:"analysis"` // analyze
	Sources  []SourceState    `json:"sources"`  // prepare
	Interp   *EditStream      `json:"interp"`   // interp (preview tier)
	Matte    *MatteState      `json:"matte"`    // matte
	TryPath  string           `json:"tryPath"`  // matte preview
	Outputs  []string         `json:"outputs"`  // render, text
	Encoder  string           `json:"encoder"`  // render
	Speed    float64          `json:"speed"`    // render: media seconds per wall second
}
