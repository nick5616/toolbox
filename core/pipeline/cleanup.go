package pipeline

import (
	"context"
	"log/slog"
	"os"

	"toolbox/core"
)

// cleanup deletes a run's temporary files (SPEC.md §8.7): only files that
// are registered outputs of the run's own jobs, inside the Library folder and
// not kept by a non-temporary cell. Run inputs are never touched. It returns
// how many files were removed.
func (l *loop) cleanup(rs *runState) int {
	lib := l.r.cfg.Settings().LibraryDir
	rs.r.Cleaned = true
	l.touch(rs)
	if lib == "" || l.r.cfg.Outputs == nil || l.r.cfg.Jobs == nil {
		return 0
	}
	// Outputs of this run's jobs, by ID, with their current paths.
	own := map[string]core.Output{}
	for _, it := range rs.r.Items {
		for _, c := range it.Cells {
			for _, id := range c.JobIDs {
				// Fresh records: a rename moved files since the cached snapshot.
				if j, err := l.r.cfg.Jobs.Get(context.Background(), id); err == nil {
					for _, o := range j.Outputs {
						own[o.ID] = o
					}
				}
			}
		}
	}
	keepID := map[string]bool{}
	keepPath := map[string]bool{}
	for _, it := range rs.r.Items {
		for _, c := range it.Cells {
			for _, f := range c.Files {
				if !f.Temporary {
					keepPath[pathKey(f.Path)] = true
					if f.OutputID != "" {
						keepID[f.OutputID] = true
					}
				}
			}
		}
	}
	done := map[string]bool{}
	var removed []string
	for _, it := range rs.r.Items {
		for _, c := range it.Cells {
			for _, f := range c.Files {
				if !f.Temporary || f.OutputID == "" || done[f.OutputID] {
					continue
				}
				o, ok := own[f.OutputID]
				if !ok || keepID[o.ID] || keepPath[pathKey(o.Path)] || !within(lib, o.Path) {
					continue
				}
				done[o.ID] = true
				if info, err := os.Lstat(o.Path); err == nil {
					if !info.Mode().IsRegular() {
						continue
					}
					if err := os.Remove(o.Path); err != nil {
						slog.Warn("pipelines: delete temporary file", "err", err)
						continue
					}
				}
				if err := l.r.cfg.Outputs.DeleteOutput(context.Background(), o.ID); err != nil && !core.IsCode(err, core.CodeNotFound) {
					slog.Warn("pipelines: remove library record", "err", err)
				}
				removed = append(removed, o.ID)
			}
		}
	}
	if len(removed) > 0 {
		l.r.cfg.Em.Emit(core.EventLibraryRemoved, core.OutputsRemoved{IDs: removed})
	}
	return len(removed)
}
