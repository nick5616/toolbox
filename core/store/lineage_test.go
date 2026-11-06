package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"toolbox/core"
)

func putOut(t *testing.T, db *DB, path, jobID, module string, created int64, size int64, kind core.OutputKind) core.Output {
	t.Helper()
	o, err := db.UpsertOutput(context.Background(), core.Output{
		ID: core.NewID(), JobID: jobID, ModuleID: module, Path: path, Name: filepath.Base(path),
		Kind: kind, SizeBytes: size, CreatedAt: created, Tags: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestLineageCRUDAndCascade(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	o1 := putOut(t, db, "/lib/a.png", "", "m", 1, 1, core.KindImage)
	o2 := putOut(t, db, "/lib/b.png", "", "m", 2, 1, core.KindImage)
	if err := db.AddOutputInputs(ctx, o1.ID, []string{"/in/x.png", "/in/y.png"}); err != nil {
		t.Fatal(err)
	}
	// idempotent
	if err := db.AddOutputInputs(ctx, o1.ID, []string{"/in/x.png"}); err != nil {
		t.Fatal(err)
	}
	if err := db.AddOutputInputs(ctx, o2.ID, []string{"/in/x.png"}); err != nil {
		t.Fatal(err)
	}
	got, err := db.OutputInputs(ctx, o1.ID)
	if err != nil || !reflect.DeepEqual(got, []string{"/in/x.png", "/in/y.png"}) {
		t.Fatalf("inputs = %v, %v", got, err)
	}
	from, err := db.OutputsFromInput(ctx, "/in/x.png")
	if err != nil || len(from) != 2 || from[0].ID != o2.ID {
		t.Fatalf("from = %+v, %v", from, err)
	}
	if none, _ := db.OutputsFromInput(ctx, "/nope"); none == nil || len(none) != 0 {
		t.Fatalf("none = %#v", none)
	}
	if err := db.DeleteOutput(ctx, o1.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := db.OutputInputs(ctx, o1.ID); len(got) != 0 {
		t.Fatalf("cascade failed: %v", got)
	}
	if from, _ := db.OutputsFromInput(ctx, "/in/x.png"); len(from) != 1 {
		t.Fatalf("after delete: %+v", from)
	}
}

func TestBackfillLineage(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	j1 := mkJob("j1", "m", core.JobDone, 1)
	j1.Inputs = []string{"/in/one.jpg"}
	j2 := mkJob("j2", "m", core.JobDone, 2)
	j2.Inputs = []string{"/in/cat.jpg", "/in/dog.jpg"}
	for _, j := range []core.Job{j1, j2} {
		if err := db.InsertJob(ctx, j); err != nil {
			t.Fatal(err)
		}
	}
	a := putOut(t, db, "/lib/one-x.png", "j1", "m", 1, 1, core.KindImage)
	b := putOut(t, db, "/lib/dog_x.png", "j2", "m", 2, 1, core.KindImage)
	putOut(t, db, "/lib/nojob.png", "", "m", 3, 1, core.KindImage)
	n, err := db.BackfillLineage(ctx)
	if err != nil || n != 2 {
		t.Fatalf("added %d, %v", n, err)
	}
	if got, _ := db.OutputInputs(ctx, a.ID); !reflect.DeepEqual(got, []string{"/in/one.jpg"}) {
		t.Fatalf("a: %v", got)
	}
	if got, _ := db.OutputInputs(ctx, b.ID); !reflect.DeepEqual(got, []string{"/in/dog.jpg"}) {
		t.Fatalf("b: %v", got)
	}
	if n, _ := db.BackfillLineage(ctx); n != 0 {
		t.Fatalf("second backfill added %d", n)
	}
}

func TestQueryLibrary(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	lib := filepath.Join(t.TempDir(), "Toolbox")
	sub := filepath.Join(lib, "Images")
	deep := filepath.Join(sub, "deep")
	for i := 0; i < 7; i++ {
		kind, mod, dirp := core.KindImage, "img", sub
		if i%3 == 0 {
			kind, mod = core.KindAudio, "aud"
		}
		if i == 6 {
			dirp = deep
		}
		name := fmt.Sprintf("%c_file%d.dat", 'a'+rune(6-i), i)
		putOut(t, db, filepath.Join(dirp, name), "", mod, int64(100+i), int64(10*(i%4)), kind)
	}
	page := func(q core.LibraryQuery) core.OutputPage {
		t.Helper()
		p, err := db.QueryLibrary(ctx, q, lib)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	if p := page(core.LibraryQuery{}); len(p.Items) != 7 || p.Items[0].CreatedAt != 106 {
		t.Fatalf("default: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{ModuleID: "aud"}); len(p.Items) != 3 {
		t.Fatalf("module: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Kinds: []core.OutputKind{core.KindImage}}); len(p.Items) != 4 {
		t.Fatalf("kinds: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Search: "FILE3"}); len(p.Items) != 1 {
		t.Fatalf("search: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Search: "%"}); len(p.Items) != 0 {
		t.Fatalf("search wildcard: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Since: 102, Until: 104}); len(p.Items) != 3 {
		t.Fatalf("range: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Folder: "Images"}); len(p.Items) != 6 {
		t.Fatalf("folder: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Folder: "Images/deep"}); len(p.Items) != 1 {
		t.Fatalf("deep folder: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Folder: "Nope"}); len(p.Items) != 0 {
		t.Fatalf("missing folder: %d", len(p.Items))
	}
	if p := page(core.LibraryQuery{Sort: core.SortOldest}); p.Items[0].CreatedAt != 100 {
		t.Fatalf("oldest: %d", p.Items[0].CreatedAt)
	}
	if p := page(core.LibraryQuery{Sort: core.SortName}); p.Items[0].Name != "a_file6.dat" {
		t.Fatalf("name: %s", p.Items[0].Name)
	}
	if p := page(core.LibraryQuery{Sort: core.SortSize}); p.Items[0].SizeBytes != 30 {
		t.Fatalf("size: %d", p.Items[0].SizeBytes)
	}
	if _, err := db.QueryLibrary(ctx, core.LibraryQuery{Sort: "bogus"}, lib); err == nil {
		t.Fatal("bogus sort accepted")
	}
	if _, err := db.QueryLibrary(ctx, core.LibraryQuery{Cursor: "!!"}, lib); err == nil {
		t.Fatal("bad cursor accepted")
	}
	// paging through every sort sees each row once
	for _, s := range []core.LibrarySort{core.SortNewest, core.SortOldest, core.SortName, core.SortSize} {
		seen := map[string]bool{}
		cur := ""
		for i := 0; i < 10; i++ {
			p := page(core.LibraryQuery{Sort: s, Limit: 3, Cursor: cur})
			for _, o := range p.Items {
				if seen[o.ID] {
					t.Fatalf("%s: duplicate %s", s, o.Name)
				}
				seen[o.ID] = true
			}
			if p.NextCursor == "" {
				break
			}
			cur = p.NextCursor
		}
		if len(seen) != 7 {
			t.Fatalf("%s: saw %d", s, len(seen))
		}
	}
	// a cursor from another sort is refused
	p := page(core.LibraryQuery{Limit: 2})
	if _, err := db.QueryLibrary(ctx, core.LibraryQuery{Sort: core.SortName, Cursor: p.NextCursor}, lib); err == nil {
		t.Fatal("cross-sort cursor accepted")
	}
}

func TestOutputsByPaths(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	dir := t.TempDir()
	p1 := filepath.Join(dir, "a.png")
	os.WriteFile(p1, []byte("x"), 0o644)
	putOut(t, db, p1, "", "m", 1, 1, core.KindImage)
	got, err := db.OutputsByPaths(ctx, []string{p1, "/nope"})
	if err != nil || len(got) != 1 || got[0].Missing {
		t.Fatalf("%+v %v", got, err)
	}
	if o, ok, _ := db.OutputByPath(ctx, p1); !ok || o.Path != p1 {
		t.Fatal("OutputByPath")
	}
}
