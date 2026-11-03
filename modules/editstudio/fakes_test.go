package editstudio

// Shared test helpers (Wave 0). Work packages add their own *_test.go files
// and may use these; changes here go through the architect.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"toolbox/core"
)

type memStore struct {
	mu sync.Mutex
	m  map[string]core.StoredProject
}

func (s *memStore) ListProjects(_ context.Context, kind core.ProjectKind) ([]core.StoredProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []core.StoredProject
	for _, p := range s.m {
		if p.Kind == kind {
			out = append(out, p)
		}
	}
	return out, nil
}

func (s *memStore) GetProject(_ context.Context, id string) (core.StoredProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[id]
	if !ok {
		return core.StoredProject{}, core.Errorf(core.CodeNotFound, "Project not found")
	}
	return p, nil
}

func (s *memStore) PutProject(_ context.Context, p core.StoredProject) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[p.ID] = p
	return nil
}

func (s *memStore) DeleteProject(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
	return nil
}

// newTestModule builds a module over an in-memory store and temp folders.
func newTestModule(t *testing.T) *Module {
	t.Helper()
	dir := t.TempDir()
	return New(Config{
		Store:       &memStore{m: map[string]core.StoredProject{}},
		ProjectsDir: filepath.Join(dir, "projects"),
		CacheDir:    filepath.Join(dir, "cache", "editstudio"),
		ModelsDir:   filepath.Join(dir, "models"),
	})
}

// validDoc is a small edit that passes validateShape: a song, a video track
// with a video, a photo and a colour clip, and an adjustment track.
func validDoc() EditProject {
	doc := NewProject("9:16", 30, 7)
	doc.Song = &Song{Path: "/music/song.mp3", StartMs: 10_000, EndMs: 40_000, FadeOutMs: 500}
	doc.AnalysisKey = "abc-s1-none-m0"
	doc.Sources = []Source{{Path: "/clips/a.mov", Tags: []string{"hero"}}, {Path: "/clips/b.jpg", Tags: []string{}}}
	doc.Tracks = []Track{
		{ID: "t1", Kind: "video", Name: "Video 1", Clips: []Clip{
			{ID: "c1", Kind: "video", Path: "/clips/a.mov", StartMs: 0, EndMs: 2000, InMs: 500, Volume: 1, Fit: "fill", Blend: "normal",
				Effects: `[{"id":"p1","type":"punch","enabled":true,"params":{"amount":{"base":0,"mods":[{"signal":"marker.kick","amount":1,"shape":"exp"}]}}}]`,
				Matte:   &Matte{Mode: "people", ID: "m1", FromMs: 0, ToMs: 3000, Cutout: true, Stroke: MatteStroke{Px: 4, Color: "#ffffff"}}},
			{ID: "c2", Kind: "image", Path: "/clips/b.jpg", StartMs: 2000, EndMs: 4000, Transform: `{"x":0,"y":0,"scale":{"base":1,"keys":[{"t":0,"v":1,"ease":"linear"},{"t":2000,"v":1.1,"ease":"ease"}]},"rotation":0,"opacity":1}`},
			{ID: "c3", Kind: "color", Color: "#000000", StartMs: 4000, EndMs: 5000, In: `{"kind":"flash","ms":300}`},
		}},
		{ID: "t2", Kind: "adjust", Name: "FX", Clips: []Clip{
			{ID: "c4", Kind: "adjust", StartMs: 1000, EndMs: 3000, Effects: `[]`},
		}},
	}
	doc.Captions = &Captions{Style: `{"preset":"pop"}`, Lines: ""}
	return doc
}

// recorder captures what a job reports.
type recorder struct {
	mu       sync.Mutex
	result   json.RawMessage
	outputs  []string
	progress []float64
	title    string
	logs     []string
}

// newJob builds a JobContext for o with an output and a temp dir under dir.
// Tools resolve to "<id>-bin" unless tools maps them.
func newJob(t *testing.T, dir string, o Options, r *recorder, tools map[string]string) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(o)
	out, tmp := filepath.Join(dir, "lib"), filepath.Join(dir, "tmp")
	for _, d := range []string{out, tmp} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return core.NewJobContext(core.JobContext{ID: "job1", ModuleID: ModuleID, Options: raw, OutputDir: out, TempDir: tmp},
		core.JobHooks{
			Progress: func(p float64, _ string) { r.mu.Lock(); r.progress = append(r.progress, p); r.mu.Unlock() },
			Log:      func(_ core.LogStream, line string) { r.mu.Lock(); r.logs = append(r.logs, line); r.mu.Unlock() },
			Title:    func(s string) { r.title = s },
			Output: func(p string) (core.Output, error) {
				r.mu.Lock()
				r.outputs = append(r.outputs, p)
				r.mu.Unlock()
				return core.Output{Path: p}, nil
			},
			Tool: func(id string) (string, error) {
				if p, ok := tools[id]; ok {
					return p, nil
				}
				return id + "-bin", nil
			},
			Result: func(b json.RawMessage) { r.result = b },
		})
}
