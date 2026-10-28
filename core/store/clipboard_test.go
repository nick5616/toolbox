package store

import (
	"context"
	"fmt"
	"testing"

	"toolbox/core"
)

func mkClip(id, preview string, last int64) core.ClipItem {
	return core.ClipItem{ID: id, Kind: core.ClipText, Text: preview, Preview: preview, Hash: "h-" + id,
		ByteSize: int64(len(preview)), CreatedAt: last, LastUsedAt: last}
}

func mustUpsert(t *testing.T, db *DB, c core.ClipItem) core.ClipItem {
	t.Helper()
	got, _, err := db.UpsertClip(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func clipIDs(items []core.ClipItem) []string {
	out := []string{}
	for _, c := range items {
		out = append(out, c.ID)
	}
	return out
}

func eqStrs(a, b []string) bool { return fmt.Sprint(a) == fmt.Sprint(b) }

func TestClipUpsertDedupe(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	a, inserted, err := db.UpsertClip(ctx, mkClip("a", "hello", 100))
	if err != nil || !inserted || a.ID != "a" {
		t.Fatalf("insert: %+v %v %v", a, inserted, err)
	}
	dup := mkClip("other", "hello", 500)
	dup.Hash = "h-a"
	b, inserted, err := db.UpsertClip(ctx, dup)
	if err != nil || inserted {
		t.Fatalf("dup: %v %v", inserted, err)
	}
	if b.ID != "a" || b.LastUsedAt != 500 || b.CreatedAt != 100 {
		t.Fatalf("bumped row = %+v", b)
	}
	page, _ := db.ListClips(ctx, core.ClipQuery{})
	if len(page.Items) != 1 {
		t.Fatalf("items = %d", len(page.Items))
	}
}

func TestClipOrderingAndPaging(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	mustUpsert(t, db, mkClip("a", "a", 10))
	mustUpsert(t, db, mkClip("b", "b", 20))
	mustUpsert(t, db, mkClip("c", "c", 30))
	mustUpsert(t, db, mkClip("d", "d", 30)) // same time as c: id tiebreak desc
	if _, err := db.SetPinned(ctx, "a", true); err != nil {
		t.Fatal(err)
	}
	page, err := db.ListClips(ctx, core.ClipQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a", "d", "c", "b"}; !eqStrs(clipIDs(page.Items), want) || !page.Items[0].Pinned {
		t.Fatalf("order = %v", clipIDs(page.Items))
	}
	var got []string
	cur := ""
	for i := 0; i < 10; i++ {
		p, err := db.ListClips(ctx, core.ClipQuery{Limit: 1, Cursor: cur})
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, clipIDs(p.Items)...)
		if p.NextCursor == "" {
			break
		}
		cur = p.NextCursor
	}
	if !eqStrs(got, []string{"a", "d", "c", "b"}) {
		t.Fatalf("paged = %v", got)
	}
	if _, err := db.ListClips(ctx, core.ClipQuery{Cursor: "!!"}); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("bad cursor err = %v", err)
	}
}

func TestClipSearchAndKind(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	mustUpsert(t, db, mkClip("a", "Hello World", 1))
	mustUpsert(t, db, mkClip("b", "100% sure_thing", 2))
	mustUpsert(t, db, mkClip("c", "100x surexthing", 3))
	img := mkClip("i", "screenshot", 4)
	img.Kind = core.ClipImage
	mustUpsert(t, db, img)
	search := func(s string, k core.ClipKind) []string {
		p, err := db.ListClips(ctx, core.ClipQuery{Search: s, Kind: k})
		if err != nil {
			t.Fatal(err)
		}
		return clipIDs(p.Items)
	}
	if got := search("hello", ""); !eqStrs(got, []string{"a"}) {
		t.Fatalf("ci search = %v", got)
	}
	if got := search("100%", ""); !eqStrs(got, []string{"b"}) {
		t.Fatalf("percent = %v", got)
	}
	if got := search("e_t", ""); !eqStrs(got, []string{"b"}) {
		t.Fatalf("underscore = %v", got)
	}
	if got := search("", core.ClipImage); !eqStrs(got, []string{"i"}) {
		t.Fatalf("kind = %v", got)
	}
	if got := search("screen", core.ClipText); len(got) != 0 {
		t.Fatalf("kind+search = %v", got)
	}
}

func TestClipNotFound(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	if _, err := db.GetClip(ctx, "x"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("get: %v", err)
	}
	if _, err := db.TouchClip(ctx, "x", 1); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("touch: %v", err)
	}
	if _, err := db.SetPinned(ctx, "x", true); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("pin: %v", err)
	}
}

func TestClipTouch(t *testing.T) {
	db := openTemp(t)
	mustUpsert(t, db, mkClip("a", "a", 1))
	got, err := db.TouchClip(context.Background(), "a", 99)
	if err != nil || got.LastUsedAt != 99 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestClipPrune(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	for i := 1; i <= 6; i++ {
		mustUpsert(t, db, mkClip(fmt.Sprintf("c%d", i), "x", int64(i*10)))
	}
	if _, err := db.SetPinned(ctx, "c1", true); err != nil { // oldest, pinned: exempt
		t.Fatal(err)
	}
	rm, err := db.PruneClips(ctx, 25, 0) // c2 only (c1 pinned)
	if err != nil || !eqStrs(clipIDs(rm), []string{"c2"}) {
		t.Fatalf("age prune = %v %v", clipIDs(rm), err)
	}
	rm, err = db.PruneClips(ctx, 0, 3) // 5 left, cap 3 -> c3, c4
	if err != nil || !eqStrs(clipIDs(rm), []string{"c3", "c4"}) {
		t.Fatalf("count prune = %v %v", clipIDs(rm), err)
	}
	p, _ := db.ListClips(ctx, core.ClipQuery{})
	if !eqStrs(clipIDs(p.Items), []string{"c1", "c6", "c5"}) {
		t.Fatalf("left = %v", clipIDs(p.Items))
	}
	rm, _ = db.PruneClips(ctx, 1000, 1)
	if !eqStrs(clipIDs(rm), []string{"c5", "c6"}) {
		t.Fatalf("final prune = %v", clipIDs(rm))
	}
	p, _ = db.ListClips(ctx, core.ClipQuery{})
	if len(p.Items) != 1 || p.Items[0].ID != "c1" {
		t.Fatalf("left = %v", clipIDs(p.Items))
	}
	if rm, err := db.PruneClips(ctx, 0, 0); err != nil || rm == nil || len(rm) != 0 {
		t.Fatalf("noop prune = %v %v", rm, err)
	}
}

func TestClipDeleteAndClear(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c", "d"} {
		c := mkClip(id, id, 5)
		c.ImagePath = "/p/" + id + ".png"
		mustUpsert(t, db, c)
	}
	rm, err := db.DeleteClips(ctx, []string{"a", "zzz"})
	if err != nil || !eqStrs(clipIDs(rm), []string{"a"}) || rm[0].ImagePath != "/p/a.png" {
		t.Fatalf("delete = %+v %v", rm, err)
	}
	if rm, err := db.DeleteClips(ctx, nil); err != nil || rm == nil || len(rm) != 0 {
		t.Fatalf("empty delete = %v %v", rm, err)
	}
	db.SetPinned(ctx, "b", true)
	rm, err = db.ClearClips(ctx, true)
	if err != nil || len(rm) != 2 {
		t.Fatalf("clear keep = %v %v", clipIDs(rm), err)
	}
	p, _ := db.ListClips(ctx, core.ClipQuery{})
	if !eqStrs(clipIDs(p.Items), []string{"b"}) {
		t.Fatalf("left = %v", clipIDs(p.Items))
	}
	rm, err = db.ClearClips(ctx, false)
	if err != nil || len(rm) != 1 {
		t.Fatalf("clear all = %v %v", clipIDs(rm), err)
	}
}
