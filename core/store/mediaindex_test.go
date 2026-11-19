package store

import (
	"context"
	"fmt"
	"testing"

	"toolbox/core"
	"toolbox/core/mediaindex"
)

func miItem(path, kind string) mediaindex.Item {
	return mediaindex.Item{Path: path, Source: core.SearchSourceLibrary, Kind: kind, Size: 10, ModMs: 5,
		State: mediaindex.StatePending, SpeechState: mediaindex.SpeechNone}
}

func ftsCount(t *testing.T, db *DB, q string) int {
	t.Helper()
	var n int
	if err := db.sql.QueryRow(`SELECT count(*) FROM media_text_fts WHERE media_text_fts MATCH ?`, q).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMediaStoreScanAndRename(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	if err := m.ApplyScan(ctx, mediaindex.ScanDelta{Add: []mediaindex.Item{miItem("/lib/a.jpg", "image"), miItem("/lib/b.jpg", "image")}}); err != nil {
		t.Fatal(err)
	}
	all, _ := m.AllItems(ctx)
	if len(all) != 2 {
		t.Fatalf("items = %d", len(all))
	}
	ok, err := m.RenameItem(ctx, "/lib/a.jpg", "/lib/c.jpg")
	if err != nil || !ok {
		t.Fatalf("rename: %v %v", ok, err)
	}
	if _, found, _ := m.GetItem(ctx, "/lib/a.jpg"); found {
		t.Fatal("old path still there")
	}
	// Renaming onto a stale row replaces it.
	if ok, err := m.RenameItem(ctx, "/lib/c.jpg", "/lib/b.jpg"); err != nil || !ok {
		t.Fatalf("rename onto: %v %v", ok, err)
	}
	if all, _ = m.AllItems(ctx); len(all) != 1 || all[0].Path != "/lib/b.jpg" {
		t.Fatalf("after rename onto: %+v", all)
	}
	if ok, _ := m.RenameItem(ctx, "/nope", "/x"); ok {
		t.Fatal("renamed a missing row")
	}
}

func TestMediaStoreBatchCascadeAndFTS(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	_ = m.ApplyScan(ctx, mediaindex.ScanDelta{Add: []mediaindex.Item{miItem("/lib/a.jpg", "image")}})
	it, _, _ := m.GetItem(ctx, "/lib/a.jpg")

	// a user and a hidden label that must survive a re-store
	if err := m.SetLabel(ctx, it.ID, mediaindex.LabelRow{Label: "lunch", Source: "user", Score: 1, Pos: -1}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetLabel(ctx, it.ID, mediaindex.LabelRow{Label: "fruit", Source: "hidden", Score: 0.5, Pos: -1}); err != nil {
		t.Fatal(err)
	}
	store := func(text string) {
		t.Helper()
		ids, err := m.StoreBatch(ctx, []mediaindex.BatchItem{{
			Path: "/lib/a.jpg", Size: 10, ModMs: 5, State: mediaindex.StateDone, Model: "m1",
			Vectors:     []mediaindex.VecRow{{Pos: -1, Blob: []byte{1, 2, 3, 4}}},
			Labels:      []mediaindex.LabelRow{{Label: "apple", Source: "auto", Score: 0.9, Pos: -1}, {Label: "fruit", Source: "auto", Score: 0.9, Pos: -1}},
			Texts:       []core.MediaText{{Source: "ocr", Pos: -1, EndPos: -1, Text: text}},
			TextSources: []string{"ocr", "pdf", "doc"},
		}})
		if err != nil || ids[0] == 0 {
			t.Fatalf("store: %v %v", ids, err)
		}
	}
	store("total 4471 due")
	if n := ftsCount(t, db, "4471"); n != 1 {
		t.Fatalf("fts after insert = %d", n)
	}
	// replacing the text leaves exactly one FTS row for the new words
	store("invoice lisbon")
	if ftsCount(t, db, "4471") != 0 || ftsCount(t, db, "lisbon") != 1 {
		t.Fatal("fts out of step after replace")
	}
	labels, _ := m.ItemLabels(ctx, it.ID)
	bySrc := map[string]string{}
	for _, l := range labels {
		bySrc[l.Label] = l.Source
	}
	if bySrc["lunch"] != "user" || bySrc["fruit"] != "hidden" || bySrc["apple"] != "auto" || len(labels) != 3 {
		t.Fatalf("labels after re-store: %v", bySrc)
	}
	rows, err := m.SearchText(ctx, `"lisbon"*`, 10)
	if err != nil || len(rows) != 1 || rows[0].ItemID != it.ID {
		t.Fatalf("search: %+v %v", rows, err)
	}
	// deleting the item cascades to vectors, labels, text and the FTS index
	ids, err := m.DeleteItems(ctx, []string{"/lib/a.jpg"})
	if err != nil || len(ids) != 1 {
		t.Fatalf("delete: %v %v", ids, err)
	}
	for _, tbl := range []string{"media_vectors", "media_labels", "media_text"} {
		var n int
		db.sql.QueryRow(`SELECT count(*) FROM ` + tbl).Scan(&n)
		if n != 0 {
			t.Fatalf("%s not cascaded: %d", tbl, n)
		}
	}
	if ftsCount(t, db, "lisbon") != 0 {
		t.Fatal("fts row left after cascade delete")
	}
	// the FTS integrity check passes
	if _, err := db.sql.Exec(`INSERT INTO media_text_fts(media_text_fts) VALUES ('integrity-check')`); err != nil {
		t.Fatalf("fts integrity: %v", err)
	}
}

func TestMediaStoreStaleAndChangedRows(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	_ = m.ApplyScan(ctx, mediaindex.ScanDelta{Add: []mediaindex.Item{miItem("/lib/a.jpg", "image")}})
	// a result for a file that changed while it was read is ignored
	ids, _ := m.StoreBatch(ctx, []mediaindex.BatchItem{{Path: "/lib/a.jpg", Size: 11, ModMs: 6, State: mediaindex.StateDone}})
	if ids[0] != 0 {
		t.Fatal("stale result stored")
	}
	_, _ = m.StoreBatch(ctx, []mediaindex.BatchItem{{
		Path: "/lib/a.jpg", Size: 10, ModMs: 5, State: mediaindex.StateDone, Model: "m1",
		Vectors: []mediaindex.VecRow{{Pos: -1, Blob: []byte{1, 2}}},
		Labels:  []mediaindex.LabelRow{{Label: "apple", Source: "auto", Score: 1, Pos: -1}},
		Texts:   []core.MediaText{{Source: "speech", Pos: 0, EndPos: 100, Text: "hello world"}}, TextSources: []string{"speech"},
	}})
	it, _, _ := m.GetItem(ctx, "/lib/a.jpg")
	_ = m.SetLabel(ctx, it.ID, mediaindex.LabelRow{Label: "mine", Source: "user", Score: 1, Pos: -1})
	// a changed file clears vectors, auto labels and text but keeps user labels
	changed := miItem("/lib/a.jpg", "image")
	changed.Size = 99
	if err := m.ApplyScan(ctx, mediaindex.ScanDelta{Changed: []mediaindex.Item{changed}}); err != nil {
		t.Fatal(err)
	}
	it2, _, _ := m.GetItem(ctx, "/lib/a.jpg")
	if it2.ID != it.ID || it2.State != "pending" || it2.Size != 99 || it2.Model != "" {
		t.Fatalf("changed row: %+v", it2)
	}
	if v, _ := m.ItemVectors(ctx, it.ID); len(v) != 0 {
		t.Fatal("vectors kept")
	}
	if ls, _ := m.ItemLabels(ctx, it.ID); len(ls) != 1 || ls[0].Label != "mine" {
		t.Fatalf("labels: %+v", ls)
	}
	if tx, _ := m.ItemTexts(ctx, it.ID); len(tx) != 0 {
		t.Fatal("text kept")
	}
	if ftsCount(t, db, "hello") != 0 {
		t.Fatal("fts kept")
	}
}

func TestMediaStoreStatesAndCounts(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	vid := miItem("/lib/v.mp4", "video")
	vid.SpeechState = mediaindex.SpeechPending
	aud := miItem("/lib/s.mp3", "audio")
	aud.State, aud.SpeechState = mediaindex.StateDone, mediaindex.SpeechPending
	_ = m.ApplyScan(ctx, mediaindex.ScanDelta{Add: []mediaindex.Item{miItem("/lib/a.jpg", "image"), vid, aud}})

	c, _ := m.Counts(ctx)
	if c.Total != 3 || c.Pending != 2 || c.Done != 1 || c.SpeechPending != 2 {
		t.Fatalf("counts %+v", c)
	}
	// newest first, library before projects
	p := miItem("/proj/thumb.jpg", "image")
	p.Source, p.SourceRef, p.ModMs = core.SearchSourceProject, "p1", 9999
	_ = m.ApplyScan(ctx, mediaindex.ScanDelta{Add: []mediaindex.Item{p}})
	pend, _ := m.NextPending(ctx, 10)
	if len(pend) != 3 || pend[2].Source != core.SearchSourceProject {
		t.Fatalf("order: %+v", pend)
	}
	sp, _ := m.NextSpeech(ctx, 10)
	if len(sp) != 2 {
		t.Fatalf("speech: %+v", sp)
	}
	// attempts and failure/skip states
	_ = m.SetItemState(ctx, "/lib/a.jpg", mediaindex.StagePictures, mediaindex.StateFailed, "boom", 1)
	_ = m.SetItemState(ctx, "/lib/v.mp4", mediaindex.StageSpeech, mediaindex.SpeechSkipped, "Longer than 60 min", 0)
	fs, _ := m.Failures(ctx, 10)
	if len(fs) != 2 {
		t.Fatalf("failures: %+v", fs)
	}
	a, _, _ := m.GetItem(ctx, "/lib/a.jpg")
	if a.State != "failed" || a.Attempts != 1 || a.Reason != "boom" {
		t.Fatalf("a: %+v", a)
	}
	if n, _ := m.ResetFailed(ctx); n != 1 {
		t.Fatalf("reset failed = %d", n)
	}
	_ = m.SetItemState(ctx, "/lib/a.jpg", mediaindex.StagePictures, mediaindex.StatePending, "", -1)
	if a, _, _ = m.GetItem(ctx, "/lib/a.jpg"); a.Attempts != 0 {
		t.Fatalf("attempts not reset: %d", a.Attempts)
	}
	// a model change marks done rows with another model pending
	_, _ = m.StoreBatch(ctx, []mediaindex.BatchItem{{Path: "/lib/a.jpg", Size: 10, ModMs: 5, State: "done", Model: "old"}})
	if n, _ := m.MarkModelStale(ctx, "new"); n != 1 {
		t.Fatalf("stale = %d", n)
	}
	if n, _ := m.MarkModelStale(ctx, "new"); n != 0 {
		t.Fatalf("stale again = %d", n)
	}
	if err := m.DeleteAll(ctx); err != nil {
		t.Fatal(err)
	}
	if c, _ = m.Counts(ctx); c.Total != 0 {
		t.Fatalf("after delete all: %+v", c)
	}
}

func TestMediaStoreSpeech(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	v := miItem("/lib/v.mp4", "video")
	v.SpeechState = mediaindex.SpeechPending
	_ = m.ApplyScan(ctx, mediaindex.ScanDelta{Add: []mediaindex.Item{v}})
	chunks := []core.MediaText{
		{Source: "speech", Pos: 0, EndPos: 5000, Text: "quarterly budget review"},
		{Source: "speech", Pos: 5000, EndPos: 9000, Text: "next steps"},
	}
	ok, err := m.StoreSpeech(ctx, mediaindex.SpeechWrite{Path: "/lib/v.mp4", Size: 10, ModMs: 5, State: mediaindex.SpeechDone, Chunks: chunks})
	if err != nil || !ok {
		t.Fatalf("speech: %v %v", ok, err)
	}
	if ftsCount(t, db, "quarterly") != 1 {
		t.Fatal("speech not in fts")
	}
	// a re-store replaces
	_, _ = m.StoreSpeech(ctx, mediaindex.SpeechWrite{Path: "/lib/v.mp4", Size: 10, ModMs: 5, State: mediaindex.SpeechDone, Chunks: chunks[1:]})
	if ftsCount(t, db, "quarterly") != 0 || ftsCount(t, db, "steps") != 1 {
		t.Fatal("speech replace out of step")
	}
	it, _, _ := m.GetItem(ctx, "/lib/v.mp4")
	if it.SpeechState != "done" {
		t.Fatalf("speech state %q", it.SpeechState)
	}
	if ok, _ := m.StoreSpeech(ctx, mediaindex.SpeechWrite{Path: "/lib/v.mp4", Size: 1, ModMs: 5, State: "done"}); ok {
		t.Fatal("stale speech stored")
	}
}

func TestMediaStoreLabelStats(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	var items []mediaindex.Item
	for i := 0; i < 4; i++ {
		items = append(items, miItem(fmt.Sprintf("/lib/%d.jpg", i), "image"))
	}
	_ = m.ApplyScan(ctx, mediaindex.ScanDelta{Add: items})
	for i := 0; i < 4; i++ {
		it, _, _ := m.GetItem(ctx, fmt.Sprintf("/lib/%d.jpg", i))
		_ = m.SetLabel(ctx, it.ID, mediaindex.LabelRow{Label: "apple", Source: "auto", Score: float64(i) / 10, Pos: -1})
		if i == 3 {
			_ = m.SetLabel(ctx, it.ID, mediaindex.LabelRow{Label: "apple", Source: "hidden", Score: 0.3, Pos: -1})
		}
	}
	stats, err := m.LabelStats(ctx)
	if err != nil || len(stats) != 1 {
		t.Fatalf("stats %+v %v", stats, err)
	}
	if stats[0].Count != 3 || stats[0].Cover != "/lib/2.jpg" {
		t.Fatalf("stat %+v", stats[0])
	}
	got, _ := m.ItemsWithLabels(ctx, []string{"apple"})
	if len(got) != 3 {
		t.Fatalf("items with label: %v", got)
	}
	if got, _ := m.ItemsWithLabels(ctx, []string{"apple", "pear"}); len(got) != 0 {
		t.Fatalf("all labels must match: %v", got)
	}
}

func TestMediaStoreTextVectorCache(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	if err := m.PutTextVector(ctx, "m", "a photo of a dog", []byte{1}, true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 520; i++ {
		if err := m.PutTextVector(ctx, "m", fmt.Sprintf("q%d", i), []byte{2}, false); err != nil {
			t.Fatal(err)
		}
	}
	var queries, kept int
	db.sql.QueryRow(`SELECT count(*) FROM media_text_vectors WHERE used_at > 0`).Scan(&queries)
	db.sql.QueryRow(`SELECT count(*) FROM media_text_vectors WHERE used_at = 0`).Scan(&kept)
	if queries != 500 || kept != 1 {
		t.Fatalf("queries=%d kept=%d", queries, kept)
	}
	if _, ok, _ := m.GetTextVector(ctx, "m", "q0"); ok {
		t.Fatal("oldest query vector survived")
	}
	if _, ok, _ := m.GetTextVector(ctx, "m", "q519"); !ok {
		t.Fatal("newest query vector missing")
	}
	// a query that spells a vocabulary prompt doesn't demote it
	_ = m.PutTextVector(ctx, "m", "a photo of a dog", []byte{3}, false)
	var used int64
	db.sql.QueryRow(`SELECT used_at FROM media_text_vectors WHERE text = 'a photo of a dog'`).Scan(&used)
	if used != 0 {
		t.Fatal("vocabulary prompt became a query vector")
	}
	if _, ok, _ := m.GetTextVector(ctx, "other", "a photo of a dog"); ok {
		t.Fatal("vectors are per model")
	}
}

func TestMediaStoreNameMatchesAndProjects(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	m := db.MediaIndex()
	p := miItem("/sup/projects/p1/thumb.jpg", "image")
	p.Source, p.SourceRef = core.SearchSourceProject, "p1"
	_ = m.ApplyScan(ctx, mediaindex.ScanDelta{Add: []mediaindex.Item{miItem("/lib/100%_done.jpg", "image"), miItem("/lib/x.jpg", "image"), p}})
	got, _ := m.NameMatches(ctx, "100%", 10)
	if len(got) != 1 {
		t.Fatalf("name matches (escaped %%): %+v", got)
	}
	if got, _ := m.NameMatches(ctx, "thumb", 10); len(got) != 0 {
		t.Fatal("project rows are not name-matched")
	}
	ids, err := m.DeleteProjectItems(ctx, []string{"p1"})
	if err != nil || len(ids) != 1 {
		t.Fatalf("delete project items: %v %v", ids, err)
	}
}
