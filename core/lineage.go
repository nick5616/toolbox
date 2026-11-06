package core

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
)

// Output lineage (Phase 19, SPEC.md §3.3).

// SetLineage gives the job manager the store that records output lineage.
// Without one, outputs simply have no lineage ("Origin unknown").
func (m *Jobs) SetLineage(s LineageStore) {
	m.mu.Lock()
	m.lineage = s
	m.mu.Unlock()
}

func fileStem(p string) string {
	base := filepath.Base(p)
	return strings.ToLower(strings.TrimSuffix(base, filepath.Ext(base)))
}

// LineageInputs decides which job inputs an output was made from.
// explicit != nil wins (OutputFrom). Otherwise: with one job input, that
// input; with several, the inputs whose file stem is a prefix of the
// output's stem; when none match, every input.
func LineageInputs(outputPath string, explicit, jobInputs []string) []string {
	if explicit != nil {
		return explicit
	}
	if len(jobInputs) <= 1 {
		return jobInputs
	}
	out := fileStem(outputPath)
	var matched []string
	for _, in := range jobInputs {
		s := fileStem(in)
		if s != "" && strings.HasPrefix(out, s) {
			matched = append(matched, in)
		}
	}
	if len(matched) > 0 {
		return matched
	}
	return jobInputs
}

// recordLineage stores o's inputs. Errors are logged, never fatal: a missing
// lineage row only means "Origin unknown" in the Library.
func (m *Jobs) recordLineage(o Output, explicit, jobInputs []string) {
	m.mu.Lock()
	ls := m.lineage
	m.mu.Unlock()
	if ls == nil {
		return
	}
	in := LineageInputs(o.Path, explicit, jobInputs)
	if len(in) == 0 {
		return
	}
	if err := ls.AddOutputInputs(context.Background(), o.ID, in); err != nil {
		slog.Warn("recording output lineage", "output", o.ID, "err", err)
	}
}
