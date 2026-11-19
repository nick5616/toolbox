package core

import "context"

// Smart search (Phase 20, SPEC.md Part A). FROZEN in Wave 0: these types are
// in the TS bindings and the seams below are shared by core/mediaindex,
// api/search.go and modules/captions.

// Search sources: where an indexed file lives.
const (
	SearchSourceLibrary = "library"
	SearchSourceProject = "project"
)

// Indexed kinds (media_items.kind).
const (
	MediaKindImage = "image"
	MediaKindVideo = "video"
	MediaKindAudio = "audio"
	MediaKindPDF   = "pdf"
	MediaKindDoc   = "doc"
)

// Text sources (media_text.source).
const (
	TextSourceOCR     = "ocr"     // words read in a picture, video frame or scanned page
	TextSourcePDF     = "pdf"     // a PDF's text layer
	TextSourceDoc     = "doc"     // a document's text (docx, md, html, …)
	TextSourceSpeech  = "speech"  // a transcript made by the index
	TextSourceSubs    = "subs"    // an existing transcript/subtitle output reused through lineage
	TextSourceCaption = "caption" // written by Caption Writer
)

// Label sources (media_labels.source).
const (
	LabelAuto   = "auto"
	LabelUser   = "user"
	LabelHidden = "hidden"
)

// Hit strengths, best first.
const (
	StrengthLabel  = "label"
	StrengthStrong = "strong"
	StrengthGood   = "good"
	StrengthMaybe  = "maybe"
	StrengthName   = "name"
)

// SearchQuery is one Library search.
type SearchQuery struct {
	Text       string       `json:"text"`       // free text; "" = labels/similar/filters only
	Labels     []string     `json:"labels"`     // all must match (auto or user, not hidden)
	Similar    string       `json:"similar"`    // a path: rank by look instead of text
	SimilarPos int64        `json:"similarPos"` // the frame (ms) or page of Similar; -1 = whole
	Filter     LibraryQuery `json:"filter"`     // kinds, module, since/until, folder (Search/Sort/Cursor ignored)
	Limit      int          `json:"limit"`      // default 200, max 500
}

// SearchHit is one result.
type SearchHit struct {
	Path      string     `json:"path"`
	Source    string     `json:"source"`    // library | project
	ProjectID string     `json:"projectId"` // Source == project
	Output    *Output    `json:"output"`    // when the file is a registered library output
	Kind      OutputKind `json:"kind"`
	Score     float64    `json:"score"`    // 0..1
	Strength  string     `json:"strength"` // label | strong | good | maybe | name
	// Via says how it matched: "label", "concept", a text source
	// (ocr, pdf, doc, speech, subs, caption) or "name".
	Via     []string `json:"via"`
	Pos     int64    `json:"pos"`     // -1, video/audio ms, or page/slide index
	Snippet string   `json:"snippet"` // \u0002…\u0003 around matched words; "" when not a text hit
	Moments []int64  `json:"moments"` // ≤ 5 other matching positions
}

// LabelCount is a label with how many files carry it (chip row, Things view).
type LabelCount struct {
	Label    string `json:"label"`    // vocabulary id or the user's text
	Display  string `json:"display"`  // shown text
	Category string `json:"category"` // vocabulary category; "" for user labels
	Count    int    `json:"count"`
	User     bool   `json:"user"`
	Cover    string `json:"cover"` // path of the highest-scoring file
}

// SearchPage is Query's answer.
type SearchPage struct {
	Hits    []SearchHit  `json:"hits"`
	Labels  []LabelCount `json:"labels"`  // labels whose display starts with the text (≤ 8)
	Concept bool         `json:"concept"` // concept scoring ran
	Warming bool         `json:"warming"` // the text vector is being computed; ask again on search:ready
}

// MediaLabel is one label on one file.
type MediaLabel struct {
	Label   string  `json:"label"`
	Display string  `json:"display"`
	Source  string  `json:"source"` // auto | user | hidden
	Score   float64 `json:"score"`
	Pos     int64   `json:"pos"`
}

// MediaText is one chunk of text found in a file.
type MediaText struct {
	Source string `json:"source"` // ocr | pdf | doc | speech | subs | caption
	Pos    int64  `json:"pos"`    // -1 | ms | page/slide index
	EndPos int64  `json:"endPos"` // speech: chunk end ms; else -1
	Text   string `json:"text"`
}

// SearchStatus is the index's state for the status line and Settings.
type SearchStatus struct {
	Installed     bool   `json:"installed"` // the pack's required components are present
	Enabled       bool   `json:"enabled"`
	Paused        bool   `json:"paused"`
	Waiting       bool   `json:"waiting"` // work is pending but the user's jobs are running
	Total         int    `json:"total"`
	Done          int    `json:"done"`
	Pending       int    `json:"pending"`
	Failed        int    `json:"failed"`
	Skipped       int    `json:"skipped"`
	SpeechPending int    `json:"speechPending"`
	SpeechDone    int    `json:"speechDone"`
	Stage         string `json:"stage"`   // "" | pictures | text | speech
	Current       string `json:"current"` // file name being worked on
	Model         string `json:"model"`
	IndexBytes    int64  `json:"indexBytes"`
	LastError     string `json:"lastError"`
}

// SearchFailure is a file the index couldn't read.
type SearchFailure struct {
	Path     string `json:"path"`
	Reason   string `json:"reason"`
	State    string `json:"state"` // failed | skipped
	Stage    string `json:"stage"` // pictures | speech
	Attempts int    `json:"attempts"`
	At       int64  `json:"at"`
}

// SearchSettings are stored under the settings key "search".
type SearchSettings struct {
	Enabled      bool     `json:"enabled"`
	Paused       bool     `json:"paused"`
	ReadText     bool     `json:"readText"`
	Speech       bool     `json:"speech"`
	SpeechMaxMin int      `json:"speechMaxMin"`
	Skip         []string `json:"skip"` // library-relative folders, "/"-separated
}

// DefaultSearchSettings: everything on; indexing starts once the pack is installed.
func DefaultSearchSettings() SearchSettings {
	return SearchSettings{Enabled: true, ReadText: true, Speech: true, SpeechMaxMin: 60, Skip: []string{}}
}

// SearchIndexed is the search:indexed payload.
type SearchIndexed struct {
	Paths []string `json:"paths"`
}

// SearchReady is the search:ready payload: the text vector for Text is cached.
type SearchReady struct {
	Text string `json:"text"`
}

// MediaIndex is what api.SearchService needs from core/mediaindex.Index.
// Every method is safe when the index is idle or the model is missing.
type MediaIndex interface {
	Status() SearchStatus
	Query(ctx context.Context, q SearchQuery) (SearchPage, error)
	Things(ctx context.Context) ([]LabelCount, error)
	Labels(ctx context.Context, path string) ([]MediaLabel, error)
	SetUserLabel(ctx context.Context, path, label string, on bool) error
	Texts(ctx context.Context, path string) ([]MediaText, error)
	ReadAgain(ctx context.Context, path string) error
	Failures(ctx context.Context, limit int) ([]SearchFailure, error)
	Retry(ctx context.Context, paths []string) error
	Settings() SearchSettings
	SetSettings(ctx context.Context, s SearchSettings) error
	Rescan() error
	Rebuild(ctx context.Context) error
	DeleteIndex(ctx context.Context) error
	Warm()
}

// MediaTextSink lets a module store text about a file in the index
// (Caption Writer, source "caption"). Implementations replace the file's
// earlier chunks of that source. A nil-safe no-op is used when Smart search
// isn't wired.
type MediaTextSink interface {
	PutText(ctx context.Context, path, source string, chunks []MediaText) error
}

// MediaHints gives a module what the index knows about a file: its labels
// (display text, strongest first) and an excerpt of its text (≤ maxChars).
// ok is false when the file isn't indexed (or the index is absent).
type MediaHints interface {
	Hints(ctx context.Context, path string, maxChars int) (labels []string, text string, ok bool)
}

// NopMediaIndex implements MediaTextSink and MediaHints with no index.
type NopMediaIndex struct{}

// PutText implements MediaTextSink.
func (NopMediaIndex) PutText(context.Context, string, string, []MediaText) error { return nil }

// Hints implements MediaHints.
func (NopMediaIndex) Hints(context.Context, string, int) ([]string, string, bool) {
	return nil, "", false
}
