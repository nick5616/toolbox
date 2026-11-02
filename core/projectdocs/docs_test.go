package projectdocs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
		return p, core.Errorf(core.CodeNotFound, "Project not found")
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

type doc struct {
	Paths []string `json:"paths"`
}

func TestDocs(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	exists := filepath.Join(t.TempDir(), "a.jpg")
	if err := os.WriteFile(exists, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := &Docs{Store: &memStore{m: map[string]core.StoredProject{}}, Root: root, Kind: core.ProjectPost,
		Summarize: func(data string) (int, int) { return strings.Count(data, ".jpg"), 0 }}
	info, err := d.Create(ctx, "  Trip   to Paris ", doc{Paths: []string{exists}})
	if err != nil || info.Name != "Trip to Paris" || info.Items != 1 || info.Kind != core.ProjectPost {
		t.Fatalf("create = %+v, %v", info, err)
	}
	got, err := Get[doc](ctx, d, info.ID)
	if err != nil || len(got.Paths) != 1 {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if err := os.MkdirAll(d.Dir(info.ID), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(d.ThumbPath(info.ID), []byte("jpg"), 0o644); err != nil {
		t.Fatal(err)
	}
	saved, err := d.Save(ctx, info.ID, "", doc{Paths: []string{exists, exists}})
	if err != nil || saved.Name != "Untitled" || saved.Items != 2 || saved.Thumb == "" {
		t.Fatalf("save = %+v, %v", saved, err)
	}
	dup, err := d.Duplicate(ctx, info.ID)
	if err != nil || dup.Name != "Untitled copy" || dup.Thumb == "" || dup.ID == info.ID {
		t.Fatalf("dup = %+v, %v", dup, err)
	}
	if list, _ := d.List(ctx); len(list) != 2 {
		t.Fatalf("list = %+v", list)
	}
	other := &Docs{Store: d.Store, Root: root, Kind: core.ProjectVideo}
	if _, err := Get[doc](ctx, other, info.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("wrong kind: %v", err)
	}
	if err := d.Delete(ctx, info.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(d.Dir(info.ID)); !os.IsNotExist(err) {
		t.Fatal("folder kept")
	}
	if MissingPaths(exists, "", filepath.Join(root, "nope")) != 1 {
		t.Fatal("MissingPaths")
	}
	if n := CleanName(strings.Repeat("x", 100)); len([]rune(n)) != MaxName {
		t.Fatalf("CleanName len %d", len([]rune(n)))
	}
}
