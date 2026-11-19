package mediaindex

import (
	"context"
	"sync"

	"toolbox/core"
)

// CONTRACT STUB (Wave 0): S2 implements the Index. The exported method set is
// fixed by core.MediaIndex, core.MediaTextSink, core.MediaHints and Writer.

// Store is the index's persistence (implemented in core/store/mediaindex.go).
// S2 owns both sides and shapes it as needed; it starts with settings only.
type Store interface {
	GetSetting(ctx context.Context, key string) (string, bool, error)
	SetSetting(ctx context.Context, key, value string) error
}

// SettingsKey is where SearchSettings live in the settings table.
const SettingsKey = "search"

// Index is Smart search's index.
type Index struct {
	cfg Config

	mu       sync.Mutex
	settings core.SearchSettings
}

// New makes an Index. Nothing runs until Start.
func New(cfg Config) *Index {
	return &Index{cfg: cfg, settings: core.DefaultSearchSettings()}
}

// Start loads settings and starts the scheduler goroutine (it reconciles the
// library, a stat walk, 60 s later) and returns at once; everything stops
// when ctx ends. main.go calls it from the deferred chores.
func (ix *Index) Start(ctx context.Context) error { return nil }

// Close stops the scheduler and drops the in-memory matrix.
func (ix *Index) Close() {}

// Notify tells the index about library changes (wired to library:added and
// the rename/trash/forget hooks): added or changed paths are enqueued, gone
// ones deleted, renamed ones moved (from → to).
func (ix *Index) Added(paths ...string)         {}
func (ix *Index) Removed(paths ...string)       {}
func (ix *Index) Renamed(from, to string)       {}
func (ix *Index) ProjectSaved(projectID string) {}

func errStub() error { return core.Errorf(core.CodeNotImplemented, "Smart search isn't ready yet") }

// Status implements core.MediaIndex.
func (ix *Index) Status() core.SearchStatus { return core.SearchStatus{} }

// Query implements core.MediaIndex.
func (ix *Index) Query(ctx context.Context, q core.SearchQuery) (core.SearchPage, error) {
	return core.SearchPage{Hits: []core.SearchHit{}, Labels: []core.LabelCount{}}, nil
}

// Things implements core.MediaIndex.
func (ix *Index) Things(ctx context.Context) ([]core.LabelCount, error) {
	return []core.LabelCount{}, nil
}

// Labels implements core.MediaIndex.
func (ix *Index) Labels(ctx context.Context, path string) ([]core.MediaLabel, error) {
	return []core.MediaLabel{}, nil
}

// SetUserLabel implements core.MediaIndex.
func (ix *Index) SetUserLabel(ctx context.Context, path, label string, on bool) error {
	return errStub()
}

// Texts implements core.MediaIndex.
func (ix *Index) Texts(ctx context.Context, path string) ([]core.MediaText, error) {
	return []core.MediaText{}, nil
}

// ReadAgain implements core.MediaIndex.
func (ix *Index) ReadAgain(ctx context.Context, path string) error { return errStub() }

// Failures implements core.MediaIndex.
func (ix *Index) Failures(ctx context.Context, limit int) ([]core.SearchFailure, error) {
	return []core.SearchFailure{}, nil
}

// Retry implements core.MediaIndex.
func (ix *Index) Retry(ctx context.Context, paths []string) error { return errStub() }

// Settings implements core.MediaIndex.
func (ix *Index) Settings() core.SearchSettings {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	return ix.settings
}

// SetSettings implements core.MediaIndex.
func (ix *Index) SetSettings(ctx context.Context, s core.SearchSettings) error { return errStub() }

// Rescan implements core.MediaIndex.
func (ix *Index) Rescan() error { return errStub() }

// Rebuild implements core.MediaIndex.
func (ix *Index) Rebuild(ctx context.Context) error { return errStub() }

// DeleteIndex implements core.MediaIndex.
func (ix *Index) DeleteIndex(ctx context.Context) error { return errStub() }

// Warm implements core.MediaIndex.
func (ix *Index) Warm() {}

// PutText implements core.MediaTextSink.
func (ix *Index) PutText(ctx context.Context, path, source string, chunks []core.MediaText) error {
	return nil
}

// Hints implements core.MediaHints.
func (ix *Index) Hints(ctx context.Context, path string, maxChars int) ([]string, string, bool) {
	return nil, "", false
}

// Model implements Writer.
func (ix *Index) Model() Model {
	if ix.cfg.Model == nil {
		return Model{}
	}
	return ix.cfg.Model()
}

// NeedsOCR implements Writer.
func (ix *Index) NeedsOCR(vec []float32) bool { return false }

// StoreBatch implements Writer.
func (ix *Index) StoreBatch(ctx context.Context, results []ItemResult) error { return errStub() }

// StoreSpeech implements Writer.
func (ix *Index) StoreSpeech(ctx context.Context, res SpeechResult) error { return errStub() }

// Current implements Writer.
func (ix *Index) Current(ctx context.Context, path string) ([]VectorAt, bool) { return nil, false }

// TextVector implements Writer.
func (ix *Index) TextVector(ctx context.Context, text string) ([]float32, error) {
	return nil, errStub()
}

// Prob implements Writer.
func (ix *Index) Prob(text, vec []float32) float64 { return 0 }

// TextMatch implements Writer.
func (ix *Index) TextMatch(query string, texts []core.MediaText) string { return "" }

// TranscriptsFor implements Writer.
func (ix *Index) TranscriptsFor(ctx context.Context, path string) ([]string, error) {
	if ix.cfg.TranscriptsFor == nil {
		return nil, nil
	}
	return ix.cfg.TranscriptsFor(ctx, path)
}

// SpeechMaxMin implements Writer.
func (ix *Index) SpeechMaxMin() int { return ix.Settings().SpeechMaxMin }
