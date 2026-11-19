// Package mediaindex is Smart search's index (Phase 20, SPEC.md Part A):
// what's in every library picture, video and PDF page (vectors + labels) and
// what files say (text chunks in FTS5). It never imports Wails or modules.
//
// FROZEN in Wave 0: this file (Config, the seams the job modules use and the
// result types). S2 owns everything else in the package and core/store's
// side of Store, and may extend Store freely (it owns both ends).
package mediaindex

import (
	"context"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// Module IDs of the hidden quiet job modules (modules/mediaindex).
const (
	IndexModuleID  = "media-index"  // one batch: pictures + text (≤ 32 files)
	SpeechModuleID = "media-speech" // one file: speech
	FilterModuleID = "search-filter"
)

// Stages, as reported in SearchStatus.Stage and SearchFailure.Stage.
const (
	StagePictures = "pictures"
	StageText     = "text"
	StageSpeech   = "speech"
)

// BatchMaxFiles caps one media-index job.
const BatchMaxFiles = 32

// Model is the pinned vision–language model the vectors belong to
// (modules/mediaindex/models.go fills it).
type Model struct {
	ID    string  // e.g. "siglip2-b16"; vectors of another ID are skipped when scoring
	Dim   int     // 768
	Scale float64 // exp(logit_scale): p = sigmoid(Scale·cos + Bias)
	Bias  float64
	Dir   string // <models>/search/<ID>/
	Files []string
}

// Jobs is what the scheduler needs from core.Jobs.
type Jobs interface {
	Submit(ctx context.Context, moduleID string, inputs []string, optionsJSON string) ([]core.Job, error)
	Observe(fn func(core.Job)) (stop func())
	List(ctx context.Context, f core.JobFilter) ([]core.Job, error)
	Cancel(id string) error
}

// Project is a project thumbnail the index covers.
type Project struct {
	ID, ModuleID, Name string
	Thumb              string // absolute path of thumb.jpg (or render)
}

// Config wires an Index (main.go).
type Config struct {
	Store      Store
	Jobs       Jobs
	Caller     sidecar.Caller // search.embed_text for query vectors
	Emitter    core.Emitter
	LibraryDir func() string
	Model      func() Model // the pinned model with its files' directory
	// Vocabulary is the label vocabulary TSV (modules/mediaindex.Vocabulary).
	Vocabulary []byte
	// Installed reports whether media-index's required components
	// (engine + search-default) are present; speech additionally needs
	// SpeechReady.
	Installed   func() bool
	SpeechReady func() bool
	Projects    func(ctx context.Context) ([]Project, error)
	// Outputs resolves library hits to their registered outputs (nil entries
	// for unregistered files).
	Outputs func(ctx context.Context, paths []string) (map[string]*core.Output, error)
	// TranscriptsFor finds transcript outputs (srt/vtt/json from transcribe or
	// subtitles) whose lineage input is path (core/store lineage).
	TranscriptsFor func(ctx context.Context, path string) ([]string, error)
}

// BatchOptions are a media-index job's options.
type BatchOptions struct {
	ReadText bool `json:"readText"` // OCR gated pictures and textless PDF pages
}

// SpeechOptions are a media-speech job's options.
type SpeechOptions struct {
	Force bool `json:"force"` // "Transcribe now": ignore the length cap
}

// VectorAt is one picture's embedding: Pos is -1 (whole image), a video
// frame's ms or a PDF page index. Vec is L2-normalised, len == Model.Dim.
type VectorAt struct {
	Pos int64
	Vec []float32
}

// ItemResult is what a media-index job learned about one file.
type ItemResult struct {
	Path    string
	Kind    string // core.MediaKind*
	Size    int64  // as stat'ed when prepared
	ModMs   int64
	Vectors []VectorAt
	Texts   []core.MediaText // ocr | pdf | doc chunks (≤ ~1,000 chars each)
	// Failed or Skipped (one line for the user) instead of a result.
	Failed  string
	Skipped string
}

// SpeechResult is what a media-speech job learned about one file.
type SpeechResult struct {
	Path     string
	Size     int64
	ModMs    int64
	Chunks   []core.MediaText // speech | subs chunks with Pos/EndPos in ms
	NoSpeech bool
	Failed   string
	Skipped  string
}

// Writer is the seam the job modules use (implemented by *Index).
type Writer interface {
	// Model is the current pinned model.
	Model() Model
	// NeedsOCR applies the text gate (SPEC.md §3.4) to one picture vector.
	NeedsOCR(vec []float32) bool
	// StoreBatch writes one batch in one transaction and recomputes auto
	// labels (user/hidden labels are kept).
	StoreBatch(ctx context.Context, results []ItemResult) error
	// StoreSpeech writes one file's speech result.
	StoreSpeech(ctx context.Context, res SpeechResult) error
	// Current returns a file's stored vectors when its row is done, unchanged
	// on disk and of the current model (search-filter reuses them).
	Current(ctx context.Context, path string) ([]VectorAt, bool)
	// TextVector embeds (or reads from the cache) a query text.
	TextVector(ctx context.Context, text string) ([]float32, error)
	// Prob is the model's probability that text describes vec.
	Prob(text, vec []float32) float64
	// TextMatch scores texts against a query with the same rules as Query
	// (search-filter's "text" match): the strength, or "" for no match.
	TextMatch(query string, texts []core.MediaText) string
	// TranscriptsFor (from Config) for the speech job.
	TranscriptsFor(ctx context.Context, path string) ([]string, error)
	// SpeechMaxMin is the current automatic transcription cap.
	SpeechMaxMin() int
}

// Interface checks.
var (
	_ core.MediaIndex    = (*Index)(nil)
	_ core.MediaTextSink = (*Index)(nil)
	_ core.MediaHints    = (*Index)(nil)
	_ Writer             = (*Index)(nil)
)
