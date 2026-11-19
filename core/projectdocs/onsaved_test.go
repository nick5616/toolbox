package projectdocs

import (
	"context"
	"sync"
	"testing"

	"toolbox/core"
)

// SetOnSaved tells Smart search a project changed (create, save, duplicate,
// delete); with no hook nothing happens.
func TestOnSavedHook(t *testing.T) {
	ctx := context.Background()
	d := &Docs{Store: &memStore{m: map[string]core.StoredProject{}}, Root: t.TempDir(), Kind: core.ProjectPost}
	if _, err := d.Create(ctx, "no hook", doc{}); err != nil { // nil-safe
		t.Fatal(err)
	}
	var mu sync.Mutex
	var got []string
	SetOnSaved(func(id string) {
		mu.Lock()
		got = append(got, id)
		mu.Unlock()
	})
	t.Cleanup(func() { SetOnSaved(nil) })

	info, err := d.Create(ctx, "A", doc{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Save(ctx, info.ID, "A2", doc{Paths: []string{"x"}}); err != nil {
		t.Fatal(err)
	}
	dup, err := d.Duplicate(ctx, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, info.ID); err != nil {
		t.Fatal(err)
	}
	want := []string{info.ID, info.ID, dup.ID, info.ID}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != len(want) {
		t.Fatalf("hook calls = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("hook calls = %v, want %v", got, want)
		}
	}
	// a failed save (unknown project) is not reported
	before := len(got)
	mu.Unlock()
	_, _ = d.Save(ctx, "missing", "X", doc{})
	mu.Lock()
	if len(got) != before {
		t.Fatalf("a failed save was reported: %v", got)
	}
}
