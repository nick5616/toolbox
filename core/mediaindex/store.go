package mediaindex

import (
	"context"

	"toolbox/core"
)

// SettingsKey is where SearchSettings live in the settings table.
const SettingsKey = "search"

// Item states (media_items.state) and speech states.
const (
	StatePending = "pending"
	StateDone    = "done"
	StateFailed  = "failed"
	StateSkipped = "skipped"

	SpeechNone     = "none"
	SpeechPending  = "pending"
	SpeechDone     = "done"
	SpeechFailed   = "failed"
	SpeechSkipped  = "skipped"
	SpeechNoSpeech = "nospeech"
)

// Item is one media_items row.
type Item struct {
	ID          int64
	Path        string
	Source      string // core.SearchSource*
	SourceRef   string // project id
	Kind        string // core.MediaKind*
	Size        int64
	ModMs       int64
	State       string
	SpeechState string
	Reason      string
	Attempts    int
	Model       string
	IndexedAt   int64
}

// VecRow is one stored vector (fp16 blob, see EncodeVec).
type VecRow struct {
	Pos  int64
	Blob []byte
}

// LabelRow is one media_labels row (without the item).
type LabelRow struct {
	Label  string
	Source string // core.Label*
	Score  float64
	Pos    int64
}

// ScanDelta is what a reconcile changes, applied in one transaction.
type ScanDelta struct {
	// Add creates rows (state/speech state as given).
	Add []Item
	// Changed replaces a row's size/mod/state/speech state and deletes its
	// vectors, auto labels and text (user and hidden labels stay).
	Changed []Item
	// Remove deletes rows (and, by cascade, everything about them).
	Remove []string
}

// BatchItem is one file's outcome in StoreBatch. Items whose stored size/mod
// no longer match (the file changed while it was being read) are ignored.
type BatchItem struct {
	Path    string
	Size    int64
	ModMs   int64
	State   string // done | failed | skipped
	Reason  string
	Model   string
	Vectors []VecRow
	Labels  []LabelRow // auto labels to store (user/hidden rows win)
	Texts   []core.MediaText
	// TextSources are replaced by Texts (even when Texts is empty).
	TextSources []string
	// Speech: when set (non-empty), the speech state is set too.
	SpeechState string
}

// SpeechWrite is one file's speech outcome.
type SpeechWrite struct {
	Path        string
	Size, ModMs int64
	State       string // a Speech* value
	Reason      string
	Chunks      []core.MediaText
}

// TextRow is one FTS hit.
type TextRow struct {
	ItemID  int64
	Source  string
	Pos     int64
	EndPos  int64
	Snippet string
	Rank    float64 // bm25: lower (more negative) is better
}

// LabelStat is one label's usage across files (not hidden).
type LabelStat struct {
	Label      string
	Count      int
	User       int // rows with source = user
	Cover      string
	CoverScore float64
}

// Counts are the numbers behind SearchStatus.
type Counts struct {
	Total, Done, Pending, Failed, Skipped int
	SpeechPending, SpeechDone             int
}

// Store is the index's persistence (core/store/mediaindex.go). All reads are
// safe while a write is in progress.
type Store interface {
	GetSetting(ctx context.Context, key string) (string, bool, error)
	SetSetting(ctx context.Context, key, value string) error

	// Items.
	AllItems(ctx context.Context) ([]Item, error)
	GetItem(ctx context.Context, path string) (Item, bool, error)
	ItemsByIDs(ctx context.Context, ids []int64) (map[int64]Item, error)
	ApplyScan(ctx context.Context, d ScanDelta) error
	// EnsureItem inserts the row when its path is new and reports the id.
	EnsureItem(ctx context.Context, it Item) (id int64, created bool, err error)
	// NextPending lists pending rows (library before projects, newest first).
	NextPending(ctx context.Context, limit int) ([]Item, error)
	// NextSpeech lists rows whose speech is pending, smallest first.
	NextSpeech(ctx context.Context, limit int) ([]Item, error)
	// NameMatches lists library rows whose path contains the (lowercase,
	// ASCII-case-insensitive) fragment; the caller filters on the base name.
	NameMatches(ctx context.Context, fragment string, limit int) ([]Item, error)
	// SetItemState updates the state of one stage. stage is StagePictures or
	// StageSpeech. attempts is added to the row's counter (negative resets).
	SetItemState(ctx context.Context, path, stage, state, reason string, attempts int) error
	// DeleteItems removes rows and reports the removed ids.
	DeleteItems(ctx context.Context, paths []string) ([]int64, error)
	DeleteProjectItems(ctx context.Context, sourceRefs []string) ([]int64, error)
	// RenameItem moves a row's path (replacing a stale row at the target).
	// It reports false when from had no row.
	RenameItem(ctx context.Context, from, to string) (bool, error)
	MarkAllPending(ctx context.Context) error
	// MarkModelStale marks done rows of other models pending.
	MarkModelStale(ctx context.Context, model string) (int, error)
	// MarkTextKindsPending marks done image/video/pdf rows pending (Read text turned on).
	MarkTextKindsPending(ctx context.Context) (int, error)
	// EnableSpeech sets speech_state pending on audio/video rows that have none.
	EnableSpeech(ctx context.Context) (int, error)
	// ResetFailed makes failed rows with fewer than 2 attempts pending again.
	ResetFailed(ctx context.Context) (int, error)
	DeleteAll(ctx context.Context) error

	// Results.
	StoreBatch(ctx context.Context, items []BatchItem) (stored []int64, err error)
	StoreSpeech(ctx context.Context, w SpeechWrite) (bool, error)

	// Vectors.
	ItemVectors(ctx context.Context, itemID int64) ([]VecRow, error)
	// StreamVectors calls fn for every vector of done rows of the model.
	StreamVectors(ctx context.Context, model string, fn func(itemID, pos int64, blob []byte) error) error
	VectorCount(ctx context.Context, model string) (int, error)
	// DoneItemsWithVectors pages done rows of the model after afterID.
	DoneItemIDs(ctx context.Context, model string, afterID int64, limit int) ([]int64, error)

	// Labels.
	ItemLabels(ctx context.Context, itemID int64) ([]LabelRow, error)
	SetLabel(ctx context.Context, itemID int64, row LabelRow) error
	DeleteLabel(ctx context.Context, itemID int64, label string) error
	ReplaceAutoLabels(ctx context.Context, itemID int64, rows []LabelRow) error
	LabelStats(ctx context.Context) ([]LabelStat, error)
	// ItemsWithLabels returns the items carrying every label (auto or user,
	// never hidden) with the mean score.
	ItemsWithLabels(ctx context.Context, labels []string) (map[int64]float64, error)
	// LabelPositions returns pos for (item,label) rows.
	LabelRows(ctx context.Context, label string) ([]ItemLabel, error)

	// Text.
	ItemTexts(ctx context.Context, itemID int64) ([]core.MediaText, error)
	ReplaceText(ctx context.Context, itemID int64, sources []string, chunks []core.MediaText) error
	// SearchText runs an FTS5 MATCH (already built) and returns up to limit
	// chunks, best first.
	SearchText(ctx context.Context, match string, limit int) ([]TextRow, error)

	// Text vector cache.
	GetTextVector(ctx context.Context, model, text string) ([]byte, bool, error)
	// PutTextVector stores a vector. keep=false rows are query vectors and
	// only the newest 500 are kept; keep=true rows (vocabulary) stay.
	PutTextVector(ctx context.Context, model, text string, blob []byte, keep bool) error

	// Status.
	Counts(ctx context.Context) (Counts, error)
	// Failures lists rows with a failed/skipped picture or speech stage.
	Failures(ctx context.Context, limit int) ([]Item, error)
	IndexBytes(ctx context.Context) (int64, error)
}

// ItemLabel is one (item, label) row with the item's path.
type ItemLabel struct {
	ItemID int64
	Source string
	Score  float64
	Pos    int64
}
