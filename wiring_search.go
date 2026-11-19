package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"

	"toolbox/api"
	"toolbox/core"
	"toolbox/core/deps"
	mi "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
	"toolbox/core/store"
	"toolbox/modules/mediaindex"
)

// Smart search wiring (Phase 20, SPEC.md Part A).

// searchTee forwards every event and tells the index about new library
// outputs (library:added). The index is attached once it exists.
type searchTee struct {
	inner core.Emitter
	mu    sync.Mutex
	idx   *mi.Index
}

func (t *searchTee) Emit(name string, data any) {
	t.inner.Emit(name, data)
	if name != core.EventLibraryAdded {
		return
	}
	t.mu.Lock()
	idx := t.idx
	t.mu.Unlock()
	if out, ok := data.(core.Output); ok && idx != nil {
		idx.Added(out.Path)
	}
}

func (t *searchTee) attach(idx *mi.Index) {
	t.mu.Lock()
	t.idx = idx
	t.mu.Unlock()
}

// depReady reports whether a dependency is known to be installed (never runs
// a version check: deps.Known, per the start-up rule).
func depReady(depSvc *deps.Service, id string) bool {
	st, ok := depSvc.Known(id)
	return ok && (st.State == core.DepOK || st.State == core.DepOutdated)
}

// newSearchIndex builds the index (nothing runs until Start).
func newSearchIndex(db *store.DB, jobs *core.Jobs, engine sidecar.Caller, emitter core.Emitter,
	depSvc *deps.Service, settings *core.SettingsService, paths core.Paths, models func() bool, whisper func() bool) *mi.Index {
	return mi.New(mi.Config{
		Store: db.MediaIndex(), Jobs: jobs, Caller: engine, Emitter: emitter,
		LibraryDir: func() string { return settings.Current().LibraryDir },
		Model:      func() mi.Model { return mediaindex.ModelInfo(paths.ModelsDir) },
		Vocabulary: mediaindex.Vocabulary,
		Installed:  func() bool { return depReady(depSvc, sidecar.DepID) && models() },
		SpeechReady: func() bool {
			return depReady(depSvc, sidecar.DepID) && depReady(depSvc, deps.FFmpeg) && whisper()
		},
		Projects: func(ctx context.Context) ([]mi.Project, error) {
			var out []mi.Project
			for _, kind := range []core.ProjectKind{core.ProjectPost, core.ProjectComposition, core.ProjectVideo, core.ProjectEdit, core.ProjectPaint} {
				list, err := db.ListProjects(ctx, kind)
				if err != nil {
					return nil, err
				}
				for _, p := range list {
					thumb := filepath.Join(paths.SupportDir, "projects", p.ID, "thumb.jpg")
					if fi, err := os.Stat(thumb); err != nil || !fi.Mode().IsRegular() {
						continue
					}
					out = append(out, mi.Project{ID: p.ID, ModuleID: api.ModuleForProject(p), Name: p.Name, Thumb: thumb})
				}
			}
			return out, nil
		},
		Outputs: func(ctx context.Context, ps []string) (map[string]*core.Output, error) {
			list, err := db.OutputsByPaths(ctx, ps)
			if err != nil {
				return nil, err
			}
			m := make(map[string]*core.Output, len(list))
			for i := range list {
				m[list[i].Path] = &list[i]
			}
			return m, nil
		},
		TranscriptsFor: func(ctx context.Context, path string) ([]string, error) {
			outs, err := db.OutputsFromInput(ctx, path)
			if err != nil {
				return nil, err
			}
			var res []string
			for _, o := range outs {
				if o.ModuleID != "transcribe" && o.ModuleID != "subtitles" {
					continue
				}
				switch filepath.Ext(o.Path) {
				case ".srt", ".vtt", ".json":
					res = append(res, o.Path)
				}
			}
			return res, nil
		},
	})
}

// modelPresent asks a registered module whether one of its models is there.
func modelPresent(reg *core.Registry, moduleID, preset string) bool {
	m, ok := reg.Get(moduleID)
	if !ok {
		return false
	}
	mp, ok := m.(core.ModelProvider)
	return ok && mp.ModelPresent(preset)
}
