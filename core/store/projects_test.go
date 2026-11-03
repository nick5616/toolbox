package store

import (
	"context"
	"strings"
	"testing"

	"toolbox/core"
)

func TestProjectsRoundTrip(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	put := func(id string, kind core.ProjectKind, updated int64) {
		if err := db.PutProject(ctx, core.StoredProject{ID: id, Kind: kind, Name: "n " + id, Data: `{"v":1}`, CreatedAt: 1, UpdatedAt: updated}); err != nil {
			t.Fatal(err)
		}
	}
	put("a", core.ProjectPost, 1)
	put("b", core.ProjectPost, 3)
	put("c", core.ProjectVideo, 2)
	put("d", core.ProjectEdit, 4) // migration 0007
	if edits, err := db.ListProjects(ctx, core.ProjectEdit); err != nil || len(edits) != 1 {
		t.Fatalf("edits = %+v, %v", edits, err)
	}
	posts, err := db.ListProjects(ctx, core.ProjectPost)
	if err != nil || len(posts) != 2 || posts[0].ID != "b" {
		t.Fatalf("posts = %+v, %v", posts, err)
	}
	if err := db.PutProject(ctx, core.StoredProject{ID: "a", Kind: core.ProjectPost, Name: "renamed", Data: `{"v":2}`, CreatedAt: 99, UpdatedAt: 5}); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetProject(ctx, "a")
	if err != nil || got.Name != "renamed" || got.Data != `{"v":2}` || got.CreatedAt != 1 || got.Kind != core.ProjectPost {
		t.Fatalf("got = %+v, %v", got, err)
	}
	if err := db.DeleteProject(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetProject(ctx, "a"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("deleted: %v", err)
	}
	if err := db.DeleteProject(ctx, "a"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("delete again: %v", err)
	}
	big := core.StoredProject{ID: "z", Kind: core.ProjectPost, Data: strings.Repeat("x", core.MaxProjectBytes+1)}
	if err := db.PutProject(ctx, big); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("cap: %v", err)
	}
}
