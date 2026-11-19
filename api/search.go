package api

import (
	"context"

	"toolbox/core"
)

// SearchService is Smart search's Wails service (Phase 20, SPEC.md §3.7).
// CONTRACT STUB (Wave 0): the method set is final. S4 owns this file:
// argument checks, SaveText's dialog, label text rules, and anything else
// the UI needs on top of core.MediaIndex.
type SearchService struct {
	Index core.MediaIndex
	// SaveDialog asks where to save a file (title, default name); "" =
	// cancelled. Wired to the native dialog.
	SaveDialog func(title, defaultName string) (string, error)
}

func (s *SearchService) ctx() context.Context { return context.Background() }

// Status returns the index's state.
func (s *SearchService) Status() core.SearchStatus { return s.Index.Status() }

// Query runs one Library search.
func (s *SearchService) Query(q core.SearchQuery) (core.SearchPage, error) {
	return s.Index.Query(s.ctx(), q)
}

// Things lists label cards for the Things view.
func (s *SearchService) Things() ([]core.LabelCount, error) { return s.Index.Things(s.ctx()) }

// Labels lists one file's labels (hidden ones included, for undo).
func (s *SearchService) Labels(path string) ([]core.MediaLabel, error) {
	return s.Index.Labels(s.ctx(), path)
}

// SetLabel adds a user label (on), or hides an auto label / removes a user
// label (off).
func (s *SearchService) SetLabel(path, label string, on bool) error {
	return s.Index.SetUserLabel(s.ctx(), path, label, on)
}

// Texts lists the text found in one file.
func (s *SearchService) Texts(path string) ([]core.MediaText, error) {
	return s.Index.Texts(s.ctx(), path)
}

// ReadAgain re-runs OCR / transcription for one file (ignores the speech cap).
func (s *SearchService) ReadAgain(path string) error { return s.Index.ReadAgain(s.ctx(), path) }

// SaveText saves a file's text as "txt" or (speech) "srt" through a Save
// dialog; returns the saved path ("" when cancelled). stub
func (s *SearchService) SaveText(path string, format string) (string, error) {
	return "", core.Errorf(core.CodeNotImplemented, "Saving text isn't ready yet")
}

// Failures lists files the index couldn't read.
func (s *SearchService) Failures(limit int) ([]core.SearchFailure, error) {
	return s.Index.Failures(s.ctx(), limit)
}

// Retry queues failed files again.
func (s *SearchService) Retry(paths []string) error { return s.Index.Retry(s.ctx(), paths) }

// Settings returns the search settings.
func (s *SearchService) Settings() core.SearchSettings { return s.Index.Settings() }

// SetSettings stores the search settings (enabled, paused, text, speech, skip).
func (s *SearchService) SetSettings(v core.SearchSettings) error {
	return s.Index.SetSettings(s.ctx(), v)
}

// Rescan reconciles the library now.
func (s *SearchService) Rescan() error { return s.Index.Rescan() }

// Rebuild re-reads every file.
func (s *SearchService) Rebuild() error { return s.Index.Rebuild(s.ctx()) }

// DeleteIndex removes every index row and cached vector (keeps the model).
func (s *SearchService) DeleteIndex() error { return s.Index.DeleteIndex(s.ctx()) }

// Warm starts the engine's text model ahead of a search (at most once a minute).
func (s *SearchService) Warm() { s.Index.Warm() }
