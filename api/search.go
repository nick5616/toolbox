package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"toolbox/core"
)

// SearchService is Smart search's Wails service (Phase 20, SPEC.md §3.7).
// It checks arguments and adds the Save dialog and label text rules on top
// of core.MediaIndex.
type SearchService struct {
	Index core.MediaIndex
	// SaveDialog asks where to save a file (title, default name); "" =
	// cancelled. Wired to the native dialog.
	SaveDialog func(title, defaultName string) (string, error)
}

// Search limits (SPEC.md §3.7).
const (
	searchDefaultLimit = 200
	searchMaxLimit     = 500
	maxLabelRunes      = 40
)

func (s *SearchService) ctx() context.Context { return context.Background() }

func requireAbs(path string) error {
	if path == "" || !filepath.IsAbs(path) {
		return core.ValidationError("Choose a file from the Library", map[string]string{"path": "Needs a full file path"})
	}
	return nil
}

// cleanLabel trims, lowercases and checks a user label.
func cleanLabel(label string) (string, error) {
	l := strings.ToLower(strings.TrimSpace(label))
	n := utf8.RuneCountInString(l)
	if n < 1 || n > maxLabelRunes {
		return "", core.ValidationError("A label is 1 to 40 characters", map[string]string{"label": "Use 1 to 40 characters"})
	}
	for _, r := range l {
		if unicode.IsControl(r) {
			return "", core.ValidationError("A label can't contain control characters", map[string]string{"label": "Remove the control characters"})
		}
	}
	return l, nil
}

// Status returns the index's state.
func (s *SearchService) Status() core.SearchStatus { return s.Index.Status() }

// Query runs one Library search. Limit is clamped to 1..500 (0 = 200);
// Similar, when set, must be an absolute path.
func (s *SearchService) Query(q core.SearchQuery) (core.SearchPage, error) {
	switch {
	case q.Limit <= 0:
		q.Limit = searchDefaultLimit
	case q.Limit > searchMaxLimit:
		q.Limit = searchMaxLimit
	}
	if q.Similar != "" {
		if err := requireAbs(q.Similar); err != nil {
			return core.SearchPage{}, err
		}
	}
	return s.Index.Query(s.ctx(), q)
}

// Things lists label cards for the Things view.
func (s *SearchService) Things() ([]core.LabelCount, error) { return s.Index.Things(s.ctx()) }

// Labels lists one file's labels (hidden ones included, for undo).
func (s *SearchService) Labels(path string) ([]core.MediaLabel, error) {
	if err := requireAbs(path); err != nil {
		return nil, err
	}
	return s.Index.Labels(s.ctx(), path)
}

// SetLabel adds a user label (on), or hides an auto label / removes a user
// label (off). The label is trimmed and lowercased (1-40 characters).
func (s *SearchService) SetLabel(path, label string, on bool) error {
	if err := requireAbs(path); err != nil {
		return err
	}
	l, err := cleanLabel(label)
	if err != nil {
		return err
	}
	return s.Index.SetUserLabel(s.ctx(), path, l, on)
}

// Texts lists the text found in one file.
func (s *SearchService) Texts(path string) ([]core.MediaText, error) {
	if err := requireAbs(path); err != nil {
		return nil, err
	}
	return s.Index.Texts(s.ctx(), path)
}

// ReadAgain re-runs OCR / transcription for one file (ignores the speech cap).
func (s *SearchService) ReadAgain(path string) error {
	if err := requireAbs(path); err != nil {
		return err
	}
	return s.Index.ReadAgain(s.ctx(), path)
}

// SaveText saves a file's text as "txt" or (speech) "srt" through a Save
// dialog; returns the saved path ("" when cancelled).
func (s *SearchService) SaveText(path string, format string) (string, error) {
	if err := requireAbs(path); err != nil {
		return "", err
	}
	stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	var name, title, body string
	switch format {
	case "txt":
		texts, err := s.Index.Texts(s.ctx(), path)
		if err != nil {
			return "", err
		}
		if body = formatText(texts); body == "" {
			return "", core.ValidationError("This file has no text", nil)
		}
		name, title = stem+" (text).txt", "Save text"
	case "srt":
		texts, err := s.Index.Texts(s.ctx(), path)
		if err != nil {
			return "", err
		}
		if body = formatSRT(texts); body == "" {
			return "", core.ValidationError("This file has no transcript", nil)
		}
		name, title = stem+".srt", "Save transcript"
	default:
		return "", core.ValidationError("Choose txt or srt", map[string]string{"format": "Choose txt or srt"})
	}
	if s.SaveDialog == nil {
		return "", core.Errorf(core.CodeNotImplemented, "Saving isn't available here")
	}
	dest, err := s.SaveDialog(title, name)
	if err != nil {
		return "", err
	}
	if dest == "" {
		return "", nil
	}
	if sameFile(dest, path) {
		return "", core.ValidationError("Choose a different file name; the original stays as it is", nil)
	}
	if err := writeTextFile(dest, []byte(body)); err != nil {
		return "", err
	}
	return dest, nil
}

func sameFile(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	fa, err1 := os.Stat(a)
	fb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(fa, fb)
}

func writeTextFile(dest string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".toolbox-text-*")
	if err != nil {
		return fmt.Errorf("saving text: %w", err)
	}
	name := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(name)
		if werr == nil {
			werr = cerr
		}
		return fmt.Errorf("saving text: %w", werr)
	}
	if err := os.Rename(name, dest); err != nil {
		os.Remove(name)
		return fmt.Errorf("saving text: %w", err)
	}
	return nil
}

// textSources lists sources in output order with their headings.
var textSources = []struct{ source, heading string }{
	{core.TextSourceOCR, "Words read in the picture"},
	{core.TextSourcePDF, "PDF text"},
	{core.TextSourceDoc, "Document text"},
	{core.TextSourceSpeech, "Speech"},
	{core.TextSourceSubs, "Subtitles"},
	{core.TextSourceCaption, "Caption"},
}

func timed(source string) bool {
	return source == core.TextSourceSpeech || source == core.TextSourceSubs
}

func clock(ms int64) string {
	sec := max(ms, 0) / 1000
	return fmt.Sprintf("%d:%02d", sec/60, sec%60)
}

// formatText groups chunks by source under a heading line; speech and
// subtitle lines start with [m:ss].
func formatText(texts []core.MediaText) string {
	var b strings.Builder
	for _, src := range textSources {
		var group []core.MediaText
		for _, t := range texts {
			if t.Source == src.source && strings.TrimSpace(t.Text) != "" {
				group = append(group, t)
			}
		}
		if len(group) == 0 {
			continue
		}
		sort.SliceStable(group, func(i, j int) bool { return group[i].Pos < group[j].Pos })
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString(src.heading + "\n")
		for _, t := range group {
			text := strings.TrimSpace(t.Text)
			if timed(t.Source) {
				text = "[" + clock(t.Pos) + "] " + text
			}
			b.WriteString(text + "\n")
		}
	}
	return b.String()
}

func srtTime(ms int64) string {
	ms = max(ms, 0)
	return fmt.Sprintf("%02d:%02d:%02d,%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
}

// formatSRT writes the speech (or, when both exist, the existing subtitle)
// chunks as SRT cues; "" when there are none.
func formatSRT(texts []core.MediaText) string {
	pick := func(source string) []core.MediaText {
		var out []core.MediaText
		for _, t := range texts {
			if t.Source == source && strings.TrimSpace(t.Text) != "" {
				out = append(out, t)
			}
		}
		return out
	}
	cues := pick(core.TextSourceSubs)
	if len(cues) == 0 {
		cues = pick(core.TextSourceSpeech)
	}
	sort.SliceStable(cues, func(i, j int) bool { return cues[i].Pos < cues[j].Pos })
	var b strings.Builder
	for i, c := range cues {
		end := c.EndPos
		if end <= c.Pos {
			end = c.Pos + 2000
		}
		fmt.Fprintf(&b, "%d\n%s --> %s\n%s\n\n", i+1, srtTime(c.Pos), srtTime(end), strings.TrimSpace(c.Text))
	}
	return b.String()
}

// Failures lists files the index couldn't read (limit 1..500, 0 = 200).
func (s *SearchService) Failures(limit int) ([]core.SearchFailure, error) {
	if limit <= 0 {
		limit = searchDefaultLimit
	}
	return s.Index.Failures(s.ctx(), min(limit, searchMaxLimit))
}

// Retry queues failed files again.
func (s *SearchService) Retry(paths []string) error {
	for _, p := range paths {
		if err := requireAbs(p); err != nil {
			return err
		}
	}
	return s.Index.Retry(s.ctx(), paths)
}

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
