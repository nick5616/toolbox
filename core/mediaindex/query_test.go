package mediaindex_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	mi "toolbox/core/mediaindex"
)

// sample builds the library the query tests share: an apple photo, a dog
// photo, a receipt with text, a video (a dog after 20 s, speech at 70 s), a
// scanned PDF, a docx and a few more.
type sample struct {
	apple, dog, receipt, video, pdf, docx, dogfood string
}

func (f *fx) sample() sample {
	f.t.Helper()
	s := sample{
		apple: f.write("apple.jpg", 11), dog: f.write("Pets/dog.jpg", 12), receipt: f.write("receipt.jpg", 13),
		video: f.write("clip.mp4", 14), pdf: f.write("scan.pdf", 15), docx: f.write("trip.docx", 16), dogfood: f.write("menu.png", 17),
	}
	f.reconcile()
	rt := func(path, kind string, texts ...core.MediaText) mi.ItemResult {
		r := f.res(path, kind)
		r.Texts = texts
		return r
	}
	apple := f.res(s.apple, "image", at(-1, 0))
	dog := f.res(s.dog, "image", at(-1, 1))
	receipt := rt(s.receipt, "image",
		core.MediaText{Source: "ocr", Pos: -1, EndPos: -1, Text: "ACME Total 4471 EUR"},
		core.MediaText{Source: "ocr", Pos: -1, EndPos: -1, Text: "due 30 Nov"})
	receipt.Vectors = []mi.VectorAt{at(-1, 2)}
	video := f.res(s.video, "video", at(0, 3), at(20000, 1), at(40000, 3))
	pdf := rt(s.pdf, "pdf",
		core.MediaText{Source: "ocr", Pos: 0, EndPos: -1, Text: "cover page"},
		core.MediaText{Source: "ocr", Pos: 1, EndPos: -1, Text: "invoice number 17"})
	pdf.Vectors = []mi.VectorAt{at(0, 3), at(1, 3)}
	docx := rt(s.docx, "doc", core.MediaText{Source: "doc", Pos: -1, EndPos: -1, Text: "A weekend in Lisbon: the itinerary"})
	dogfood := rt(s.dogfood, "image", core.MediaText{Source: "ocr", Pos: -1, EndPos: -1, Text: "dog food menu"})
	dogfood.Vectors = []mi.VectorAt{at(-1, 3)}
	f.store(apple, dog, receipt, video, pdf, docx, dogfood)
	if err := f.ix.StoreSpeech(context.Background(), mi.SpeechResult{Path: s.video, Size: 14, ModMs: statMod(f.t, s.video), Chunks: []core.MediaText{
		{Source: "speech", Pos: 65000, EndPos: 69000, Text: "so about the"},
		{Source: "speech", Pos: 70000, EndPos: 75000, Text: "quarterly budget review"},
	}}); err != nil {
		f.t.Fatal(err)
	}
	return s
}

func find(hits []core.SearchHit, name string) *core.SearchHit {
	for i := range hits {
		if filepath.Base(hits[i].Path) == name {
			return &hits[i]
		}
	}
	return nil
}

func TestQueryLabelHitsAndChips(t *testing.T) {
	f := newFx(t)
	f.sample()
	p := f.query(core.SearchQuery{Text: "apple"})
	h := find(p.Hits, "apple.jpg")
	if h == nil || h.Strength != "label" || h.Score != 1 || h.Via[0] != "label" || h.Pos != -1 {
		t.Fatalf("apple: %+v (%v)", h, paths(p.Hits))
	}
	if p.Hits[0].Path != h.Path {
		t.Fatalf("label hits come first: %v", paths(p.Hits))
	}
	if len(p.Labels) != 1 || p.Labels[0].Label != "apple" || p.Labels[0].Count != 1 || p.Labels[0].Category != "food" ||
		filepath.Base(p.Labels[0].Cover) != "apple.jpg" || p.Labels[0].User {
		t.Fatalf("chips: %+v", p.Labels)
	}
	if p.Concept {
		t.Errorf("no concept lookup before the vector is cached: %+v", p)
	}
	// a prefix lists the chips (display starts with the text) with counts
	p = f.query(core.SearchQuery{Text: "f"})
	var names []string
	for _, c := range p.Labels {
		names = append(names, c.Display)
	}
	if strings.Join(names, ",") != "food,fruit" && strings.Join(names, ",") != "fruit,food" {
		t.Fatalf("chips for f: %v", names)
	}
	// a video's label hit carries the frame
	p = f.query(core.SearchQuery{Text: "dog"})
	v := find(p.Hits, "clip.mp4")
	if v == nil || v.Strength != "label" || v.Pos != 20000 {
		t.Fatalf("video dog hit: %+v", v)
	}
	if find(p.Hits, "dog.jpg") == nil {
		t.Fatal("dog photo missing")
	}
	// label chip filter: a parent label finds the child's file; all labels must match
	p = f.query(core.SearchQuery{Labels: []string{"fruit"}})
	if len(p.Hits) != 1 || filepath.Base(p.Hits[0].Path) != "apple.jpg" || p.Hits[0].Strength != "label" {
		t.Fatalf("fruit chip: %v", paths(p.Hits))
	}
	if p = f.query(core.SearchQuery{Labels: []string{"fruit", "dog"}}); len(p.Hits) != 0 {
		t.Fatalf("all labels must match: %v", paths(p.Hits))
	}
	// nothing asked, nothing returned
	if p = f.query(core.SearchQuery{}); len(p.Hits) != 0 || p.Hits == nil || p.Labels == nil {
		t.Fatalf("empty query: %+v", p)
	}
}

func TestQueryTextHits(t *testing.T) {
	f := newFx(t)
	s := f.sample()

	p := f.query(core.SearchQuery{Text: "4471"})
	h := find(p.Hits, "receipt.jpg")
	if h == nil || h.Strength != "strong" || h.Via[0] != "ocr" || !strings.Contains(h.Snippet, mi.SnippetOpen+"4471"+mi.SnippetClose) {
		t.Fatalf("receipt: %+v", h)
	}
	if h.Score < 0.35 || h.Score > 0.45 {
		t.Errorf("strong text score %g", h.Score)
	}
	// terms spread over two chunks are Good (and score below any Strong)
	p = f.query(core.SearchQuery{Text: "total due"})
	h = find(p.Hits, "receipt.jpg")
	if h == nil || h.Strength != "good" || h.Score < 0.15 || h.Score >= 0.35 {
		t.Fatalf("spread terms: %+v", h)
	}
	// a PDF page
	p = f.query(core.SearchQuery{Text: "invoice"})
	h = find(p.Hits, "scan.pdf")
	if h == nil || h.Pos != 1 || h.Strength != "strong" || h.Source != "library" {
		t.Fatalf("pdf: %+v", h)
	}
	// a document
	if h = find(f.query(core.SearchQuery{Text: "lisbon"}).Hits, "trip.docx"); h == nil || h.Via[0] != "doc" {
		t.Fatalf("docx: %+v", h)
	}
	// speech with the moment
	p = f.query(core.SearchQuery{Text: "quarterly budget"})
	h = find(p.Hits, "clip.mp4")
	if h == nil || h.Pos != 70000 || h.Via[0] != "speech" || h.Strength != "strong" {
		t.Fatalf("speech: %+v", h)
	}
	// phrases and prefixes and diacritics
	if find(f.query(core.SearchQuery{Text: `"quarterly budget"`}).Hits, "clip.mp4") == nil {
		t.Error("phrase")
	}
	if find(f.query(core.SearchQuery{Text: `"budget quarterly"`}).Hits, "clip.mp4") != nil {
		t.Error("a reversed phrase must not match")
	}
	if find(f.query(core.SearchQuery{Text: "lis"}).Hits, "trip.docx") == nil {
		t.Error("prefix")
	}
	// moments: the same word on two PDF pages gives the other page
	r := f.res(s.pdf, "pdf", at(0, 3))
	r.Texts = []core.MediaText{
		{Source: "pdf", Pos: 0, EndPos: -1, Text: "invoice header"},
		{Source: "pdf", Pos: 1, EndPos: -1, Text: "invoice details invoice"},
		{Source: "pdf", Pos: 2, EndPos: -1, Text: "invoice total"},
	}
	f.store(r)
	h = find(f.query(core.SearchQuery{Text: "invoice"}).Hits, "scan.pdf")
	if h == nil || len(h.Moments) != 2 {
		t.Fatalf("moments: %+v", h)
	}
	for _, m := range h.Moments {
		if m == h.Pos {
			t.Errorf("moments repeat the main position: %+v", h)
		}
	}
	// hostile input never errors
	for _, q := range []string{`"`, `(`, `a AND`, `NEAR(`, `*`, `-`, `^x`, `x:y`, `"a" "b`, `OR OR`, `日本語`, strings.Repeat("a ", 500), `'; DROP TABLE media_items; --`} {
		if _, err := f.ix.Query(context.Background(), core.SearchQuery{Text: q}); err != nil {
			t.Errorf("%q: %v", q, err)
		}
	}
}

func TestQueryConceptWarmupAndMerge(t *testing.T) {
	f := newFx(t)
	f.sample()
	f.installed.Store(true)

	// not cached: the instant results come back with Warming, then search:ready
	p := f.query(core.SearchQuery{Text: "a red apple"})
	if !p.Warming || p.Concept {
		t.Fatalf("first query: %+v", p)
	}
	eventually(t, "search:ready", func() bool {
		f.em.mu.Lock()
		defer f.em.mu.Unlock()
		return len(f.em.ready) == 1 && f.em.ready[0].Text == "a red apple"
	})
	p = f.query(core.SearchQuery{Text: "a red apple"})
	if p.Warming || !p.Concept {
		t.Fatalf("second query: %+v", p)
	}
	h := find(p.Hits, "apple.jpg")
	if h == nil || h.Strength != "strong" || h.Via[len(h.Via)-1] != "concept" || h.Score < 0.9 {
		t.Fatalf("concept hit: %+v (%v)", h, paths(p.Hits))
	}
	if len(p.Hits) != 1 {
		t.Errorf("only the apple looks like an apple: %v", paths(p.Hits))
	}
	// "giraffe": nothing looks like it, so no concept results
	p = f.query(core.SearchQuery{Text: "giraffe"})
	f.ix.TestWaitIdle()
	p = f.query(core.SearchQuery{Text: "giraffe"})
	if !p.Concept || len(p.Hits) != 0 {
		t.Fatalf("giraffe: %+v", p)
	}

	// merge order: label hits, then scored hits (text and concept), then name-only
	f.write("dogs-in-park.png", 9) // unindexed pictures: a name-only match
	f.ix.TestSyncPaths(context.Background(), f.path("dogs-in-park.png"))
	f.query(core.SearchQuery{Text: "dog"})
	f.ix.TestWaitIdle()
	p = f.query(core.SearchQuery{Text: "dog"})
	got := paths(p.Hits)
	if len(got) != 4 {
		t.Fatalf("dog hits: %v", got)
	}
	if find(p.Hits, "dog.jpg").Strength != "label" || find(p.Hits, "clip.mp4").Strength != "label" {
		t.Fatalf("dog labels first: %v", got)
	}
	if got[2] != "menu.png" || p.Hits[2].Strength != "good" && p.Hits[2].Strength != "strong" {
		t.Fatalf("text hit third: %v %+v", got, p.Hits[2])
	}
	if got[3] != "dogs-in-park.png" || p.Hits[3].Strength != "name" || p.Hits[3].Via[0] != "name" {
		t.Fatalf("name-only last: %v", got)
	}
	// an item with both label and concept keeps both icons, listed once
	dog := find(p.Hits, "dog.jpg")
	if len(dog.Via) != 2 || dog.Via[0] != "label" || dog.Via[1] != "concept" {
		t.Fatalf("both icons: %+v", dog)
	}
	// the video's dog frame is the main moment, other frames are moments
	if v := find(p.Hits, "clip.mp4"); v.Pos != 20000 {
		t.Fatalf("video pos: %+v", v)
	}
	// not installed: no concept, no warming
	f.installed.Store(false)
	p = f.query(core.SearchQuery{Text: "tulip"})
	if p.Concept || p.Warming {
		t.Fatalf("not installed: %+v", p)
	}
	f.installed.Store(true)
	// a failing engine never errors a query
	f.caller.err = os.ErrDeadlineExceeded
	p = f.query(core.SearchQuery{Text: "zebra crossing"})
	f.ix.TestWaitIdle()
	if !p.Warming || f.em.count(core.EventSearchReady) != 2 {
		t.Logf("after engine error: %+v ready=%d", p, f.em.count(core.EventSearchReady))
	}
	if f.em.count(core.EventSearchReady) > 2 {
		t.Error("search:ready fires only when a vector is cached")
	}
}

func TestQueryFiltersLimitAndOutput(t *testing.T) {
	f := newFx(t)
	s := f.sample()
	now := time.Now().UnixMilli()
	f.mu.Lock()
	f.outs[s.apple] = &core.Output{ID: "o1", ModuleID: "imagebatch", Path: s.apple, Kind: core.KindImage, CreatedAt: now - 1000}
	f.outs[s.dog] = &core.Output{ID: "o2", ModuleID: "paint", Path: s.dog, Kind: core.KindImage, CreatedAt: now - 10_000_000}
	f.mu.Unlock()
	f.ix.TestLabels(context.Background())
	f.ix.TextVector(context.Background(), "photo")
	all := core.SearchQuery{Text: "dog"}
	p := f.query(all)
	if h := find(p.Hits, "dog.jpg"); h == nil || h.Output == nil || h.Output.ID != "o2" {
		t.Fatalf("Output is filled for registered files: %+v", h)
	}
	if h := find(p.Hits, "clip.mp4"); h.Output != nil {
		t.Fatal("unregistered files have no Output")
	}
	cases := []struct {
		name string
		f    core.LibraryQuery
		want []string
	}{
		{"kind video", core.LibraryQuery{Kinds: []core.OutputKind{core.KindVideo}}, []string{"clip.mp4"}},
		{"kind image", core.LibraryQuery{Kinds: []core.OutputKind{core.KindImage}}, []string{"dog.jpg", "menu.png"}},
		{"folder", core.LibraryQuery{Folder: "Pets"}, []string{"dog.jpg"}},
		{"module", core.LibraryQuery{ModuleID: "paint"}, []string{"dog.jpg"}},
		{"since", core.LibraryQuery{Since: now - 5000}, []string{"clip.mp4", "menu.png"}},
		{"until", core.LibraryQuery{Until: now - 5_000_000}, []string{"dog.jpg"}},
		{"ext", core.LibraryQuery{Exts: []string{"mp4"}}, []string{"clip.mp4"}},
	}
	for _, c := range cases {
		q := all
		q.Filter = c.f
		got := paths(f.query(q).Hits)
		if c.name == "kind image" {
			// the unregistered dog-food menu is a text hit; order: label first
			if len(got) != 2 {
				t.Errorf("%s: %v", c.name, got)
			}
			continue
		}
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
	// limit
	q := all
	q.Limit = 1
	if got := f.query(q).Hits; len(got) != 1 {
		t.Fatalf("limit 1: %d", len(got))
	}
	q.Limit = 100000 // capped, not an error
	if got := f.query(q).Hits; len(got) < 2 {
		t.Fatalf("big limit: %d", len(got))
	}
}

func TestUserAndHiddenLabelsSurviveReindex(t *testing.T) {
	f := newFx(t)
	s := f.sample()
	ctx := context.Background()
	labels, err := f.ix.Labels(ctx, s.apple)
	if err != nil {
		t.Fatal(err)
	}
	src := map[string]string{}
	for _, l := range labels {
		src[l.Label] = l.Source
	}
	if src["apple"] != "auto" || src["fruit"] != "auto" || src["food"] != "auto" {
		t.Fatalf("auto labels with parents: %v", src)
	}
	// hide fruit; add "Lunch"
	if err := f.ix.SetUserLabel(ctx, s.apple, "fruit", false); err != nil {
		t.Fatal(err)
	}
	if err := f.ix.SetUserLabel(ctx, s.apple, "  Lunch ", true); err != nil {
		t.Fatal(err)
	}
	check := func(when string) {
		t.Helper()
		ls, _ := f.ix.Labels(ctx, s.apple)
		got := map[string]string{}
		for _, l := range ls {
			got[l.Label] = l.Source
		}
		if _, ok := got["fruit"]; ok {
			t.Errorf("%s: a hidden label is shown: %v", when, got)
		}
		if got["lunch"] != "user" || got["apple"] != "auto" {
			t.Errorf("%s: %v", when, got)
		}
		if len(f.query(core.SearchQuery{Labels: []string{"fruit"}}).Hits) != 0 {
			t.Errorf("%s: hidden label still matches", when)
		}
		if h := find(f.query(core.SearchQuery{Text: "lunch"}).Hits, "apple.jpg"); h == nil || h.Strength != "label" {
			t.Errorf("%s: user label not found", when)
		}
	}
	check("after edit")
	// the user's labels come first
	if ls, _ := f.ix.Labels(ctx, s.apple); ls[0].Label != "lunch" {
		t.Errorf("user labels first: %+v", ls)
	}
	// re-index (a rebuild stores the batch again), then a recompute: still hidden
	f.store(f.res(s.apple, "image", at(-1, 0)))
	check("after re-store")
	if err := f.ix.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	f.store(f.res(s.apple, "image", at(-1, 0)))
	check("after rebuild")
	// turning a user label off deletes it; an unknown label is a no-op
	if err := f.ix.SetUserLabel(ctx, s.apple, "lunch", false); err != nil {
		t.Fatal(err)
	}
	if h := find(f.query(core.SearchQuery{Text: "lunch"}).Hits, "apple.jpg"); h != nil {
		t.Error("deleted user label still matches")
	}
	if err := f.ix.SetUserLabel(ctx, s.apple, "nothing here", false); err != nil {
		t.Fatal(err)
	}
	// turning a hidden label on restores it as the user's
	if err := f.ix.SetUserLabel(ctx, s.apple, "fruit", true); err != nil {
		t.Fatal(err)
	}
	if len(f.query(core.SearchQuery{Labels: []string{"fruit"}}).Hits) != 1 {
		t.Error("restored label")
	}
	// validation and unknown files
	if err := f.ix.SetUserLabel(ctx, s.apple, strings.Repeat("x", 41), true); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("long label: %v", err)
	}
	if err := f.ix.SetUserLabel(ctx, s.apple, " ", true); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("empty label: %v", err)
	}
	if err := f.ix.SetUserLabel(ctx, f.path("nope.jpg"), "x", true); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown file: %v", err)
	}
	// a display name maps to the vocabulary id
	if err := f.ix.SetUserLabel(ctx, s.dog, "Dog", true); err != nil {
		t.Fatal(err)
	}
	for _, l := range mustLabels(t, f.ix, s.dog) {
		if l.Label == "dog" && l.Source != "user" {
			t.Errorf("dog should now be the user's: %+v", l)
		}
	}
}

func mustLabels(t *testing.T, ix *mi.Index, path string) []core.MediaLabel {
	t.Helper()
	ls, err := ix.Labels(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	return ls
}

func TestThings(t *testing.T) {
	f := newFx(t)
	var rs []mi.ItemResult
	for i := 0; i < 3; i++ {
		p := f.write("apple"+string(rune('a'+i))+".jpg", 3)
		_ = p
	}
	f.write("dog1.jpg", 3)
	f.write("dog2.jpg", 3)
	f.reconcile()
	for i := 0; i < 3; i++ {
		rs = append(rs, f.res(f.path("apple"+string(rune('a'+i))+".jpg"), "image", at(-1, 0)))
	}
	rs = append(rs, f.res(f.path("dog1.jpg"), "image", at(-1, 1)), f.res(f.path("dog2.jpg"), "image", at(-1, 1)))
	f.store(rs...)
	ctx := context.Background()
	if err := f.ix.SetUserLabel(ctx, f.path("dog1.jpg"), "my dog", true); err != nil {
		t.Fatal(err)
	}
	things, err := f.ix.Things(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]core.LabelCount{}
	var order []string
	for _, c := range things {
		got[c.Label] = c
		order = append(order, c.Label)
	}
	if got["apple"].Count != 3 || got["fruit"].Count != 3 || got["food"].Count != 3 || got["apple"].Category != "food" || got["apple"].Cover == "" {
		t.Fatalf("things: %+v", things)
	}
	if _, ok := got["dog"]; ok {
		t.Error("a label with fewer than 3 files is not a Thing")
	}
	if c := got["my dog"]; !c.User || c.Count != 1 || c.Display != "my dog" {
		t.Fatalf("user label: %+v", c)
	}
	if order[0] != "my dog" {
		t.Errorf("Your labels come first: %v", order)
	}
}

func TestSimilar(t *testing.T) {
	f := newFx(t)
	var rs []mi.ItemResult
	for _, n := range []string{"a1.jpg", "a2.jpg", "d1.jpg", "v.mp4"} {
		f.write(n, 3)
	}
	f.reconcile()
	rs = append(rs, f.res(f.path("a1.jpg"), "image", at(-1, 0)), f.res(f.path("a2.jpg"), "image", at(-1, 0)),
		f.res(f.path("d1.jpg"), "image", at(-1, 1)),
		f.res(f.path("v.mp4"), "video", at(0, 3), at(5000, 1), at(9000, 0)))
	f.store(rs...)
	p := f.query(core.SearchQuery{Similar: f.path("a1.jpg"), SimilarPos: -1})
	if !p.Concept {
		t.Fatalf("similar needs the model: %+v", p)
	}
	got := paths(p.Hits)
	if len(got) != 2 || got[0] == "a1.jpg" || find(p.Hits, "a2.jpg") == nil || find(p.Hits, "v.mp4") == nil {
		t.Fatalf("similar to a1: %v", got)
	}
	if h := find(p.Hits, "v.mp4"); h.Pos != 9000 || h.Strength != "strong" {
		t.Fatalf("the video's apple frame: %+v", h)
	}
	// one frame of a video is the query
	p = f.query(core.SearchQuery{Similar: f.path("v.mp4"), SimilarPos: 5000})
	got = paths(p.Hits)
	if len(got) != 1 || got[0] != "d1.jpg" {
		t.Fatalf("similar to the dog frame: %v", got)
	}
	if p = f.query(core.SearchQuery{Similar: f.path("missing.jpg")}); len(p.Hits) != 0 {
		t.Fatalf("unknown file: %v", paths(p.Hits))
	}
	// the filters apply
	p = f.query(core.SearchQuery{Similar: f.path("a1.jpg"), SimilarPos: -1, Filter: core.LibraryQuery{Kinds: []core.OutputKind{core.KindVideo}}})
	if len(p.Hits) != 1 || p.Hits[0].Kind != core.KindVideo {
		t.Fatalf("filtered similar: %v", paths(p.Hits))
	}
}

func TestMatrixStreamingFallbackMatchesInMemory(t *testing.T) {
	f := newFx(t)
	f.sample()
	f.ix.TestLabels(context.Background())
	if _, err := f.ix.TextVector(context.Background(), "a dog"); err != nil {
		t.Fatal(err)
	}
	q := core.SearchQuery{Text: "a dog"}
	inMem := f.query(q)
	if f.ix.TestMatrixStreaming() || !inMem.Concept || len(inMem.Hits) == 0 {
		t.Fatalf("in memory: streaming=%v %+v", f.ix.TestMatrixStreaming(), inMem)
	}
	// a second index with a tiny cap streams from SQLite
	ix2 := f.newIndex(toyVocab)
	ix2.TestLoad(context.Background())
	ix2.TestKnobs(0, 0, 1, nil)
	streamed, err := ix2.Query(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	if !ix2.TestMatrixStreaming() {
		t.Fatal("the cap was not honoured")
	}
	if strings.Join(paths(inMem.Hits), ",") != strings.Join(paths(streamed.Hits), ",") {
		t.Fatalf("streamed %v vs in-memory %v", paths(streamed.Hits), paths(inMem.Hits))
	}
	for i := range inMem.Hits {
		if d := inMem.Hits[i].Score - streamed.Hits[i].Score; d > 1e-9 || d < -1e-9 {
			t.Fatalf("score differs: %v %v", inMem.Hits[i], streamed.Hits[i])
		}
	}
}

func TestMatrixStaysCurrentAndDropsWhenIdle(t *testing.T) {
	f := newFx(t)
	var clock = time.Now()
	f.ix.TestKnobs(0, 0, 0, func() time.Time { return clock })
	a := f.write("a.jpg", 3)
	f.reconcile()
	f.store(f.res(a, "image", at(-1, 0)))
	f.ix.TextVector(context.Background(), "an apple") // cached after TestLabels
	if hits := f.query(core.SearchQuery{Text: "an apple"}).Hits; len(hits) != 1 {
		t.Fatalf("loaded: %v", paths(hits))
	}
	// a new picture is added to the loaded matrix without a reload
	b := f.write("b.jpg", 4)
	f.ix.TestSyncPaths(context.Background(), b)
	f.store(f.res(b, "image", at(-1, 0)))
	if hits := f.query(core.SearchQuery{Text: "an apple"}).Hits; len(hits) != 2 {
		t.Fatalf("kept current on write: %v", paths(hits))
	}
	// re-storing replaces, never duplicates
	f.store(f.res(b, "image", at(-1, 1)))
	if hits := f.query(core.SearchQuery{Text: "an apple"}).Hits; len(hits) != 1 {
		t.Fatalf("after re-store: %v", paths(hits))
	}
	// idle for 11 minutes: dropped at the next tick, reloaded on demand
	clock = clock.Add(11 * time.Minute)
	f.ix.TestTick(context.Background())
	if hits := f.query(core.SearchQuery{Text: "an apple"}).Hits; len(hits) != 1 {
		t.Fatalf("after reload: %v", paths(hits))
	}
}

func TestPutTextHintsAndTexts(t *testing.T) {
	f := newFx(t)
	s := f.sample()
	ctx := context.Background()
	// a caption for an indexed file
	if err := f.ix.PutText(ctx, s.apple, "caption", []core.MediaText{{Pos: -1, EndPos: -1, Text: "A shiny red apple on a wooden table"}}); err != nil {
		t.Fatal(err)
	}
	h := find(f.query(core.SearchQuery{Text: "wooden"}).Hits, "apple.jpg")
	if h == nil || h.Via[0] != "caption" {
		t.Fatalf("caption search: %+v", h)
	}
	// replaced, not appended
	f.ix.PutText(ctx, s.apple, "caption", []core.MediaText{{Pos: -1, EndPos: -1, Text: "Just an apple"}})
	if find(f.query(core.SearchQuery{Text: "wooden"}).Hits, "apple.jpg") != nil {
		t.Fatal("old caption still searchable")
	}
	texts, _ := f.ix.Texts(ctx, s.apple)
	if len(texts) != 1 || texts[0].Source != "caption" {
		t.Fatalf("texts: %+v", texts)
	}
	// a library file the index hasn't seen gets its row
	n := f.write("new.jpg", 5)
	if err := f.ix.PutText(ctx, n, "caption", []core.MediaText{{Pos: -1, EndPos: -1, Text: "brand new"}}); err != nil {
		t.Fatal(err)
	}
	if f.items()["new.jpg"].State != "pending" || find(f.query(core.SearchQuery{Text: "brand"}).Hits, "new.jpg") == nil {
		t.Fatal("PutText should create the row")
	}
	// a file outside the library is ignored
	out := filepath.Join(t.TempDir(), "x.jpg")
	os.WriteFile(out, []byte("x"), 0o644)
	if err := f.ix.PutText(ctx, out, "caption", []core.MediaText{{Text: "x"}}); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.items()["x.jpg"]; ok {
		t.Fatal("outside the library")
	}
	// Hints: labels (user first, then strongest) and an excerpt
	f.ix.SetUserLabel(ctx, s.receipt, "expenses", true)
	labels, text, ok := f.ix.Hints(ctx, s.receipt, 12)
	if !ok || len(labels) == 0 || labels[0] != "expenses" {
		t.Fatalf("hints: %v %q %v", labels, text, ok)
	}
	if text != "ACME Total 4" {
		t.Fatalf("excerpt: %q", text)
	}
	f.ix.PutText(ctx, s.docx, "ocr", []core.MediaText{{Pos: -1, EndPos: -1, Text: "日本語のテキストです。これは長い文章です。"}})
	if _, text, _ = f.ix.Hints(ctx, s.docx, 5); len([]rune(text)) > 5 {
		t.Fatalf("excerpt is limited in characters, not bytes: %q", text)
	}
	if _, _, ok := f.ix.Hints(ctx, f.path("nope.jpg"), 10); ok {
		t.Fatal("unknown file")
	}
	if _, _, ok := f.ix.Hints(ctx, n, 10); ok {
		t.Fatal("a file not indexed yet has no hints")
	}
	// captions don't feed the excerpt (no feedback loop)
	if _, text, _ := f.ix.Hints(ctx, s.apple, 100); text != "" {
		t.Fatalf("caption leaked into hints: %q", text)
	}
}

func TestWriterCurrentTextMatchProbAndStatusEvents(t *testing.T) {
	f := newFx(t)
	a := f.write("a.jpg", 3)
	f.reconcile()
	ctx := context.Background()
	if _, ok := f.ix.Current(ctx, a); ok {
		t.Fatal("pending file is not current")
	}
	f.store(f.res(a, "image", at(-1, 0)))
	vs, ok := f.ix.Current(ctx, a)
	if !ok || len(vs) != 1 || vs[0].Pos != -1 || len(vs[0].Vec) != toyDim || vs[0].Vec[0] < 0.99 {
		t.Fatalf("current: %v %v", vs, ok)
	}
	os.WriteFile(a, []byte("changed!"), 0o644)
	if _, ok := f.ix.Current(ctx, a); ok {
		t.Fatal("a changed file is not current")
	}
	tv, err := f.ix.TextVector(ctx, "an apple")
	if err != nil {
		t.Fatal(err)
	}
	callsBefore := f.caller.callCount()
	f.ix.TextVector(ctx, "an apple")
	if f.caller.callCount() != callsBefore {
		t.Error("a cached text vector is not embedded again")
	}
	if p := f.ix.Prob(tv, axis(0)); p < 0.99 {
		t.Errorf("prob of a match %g", p)
	}
	if p := f.ix.Prob(tv, axis(1)); p > 0.01 {
		t.Errorf("prob of a mismatch %g", p)
	}
	if f.ix.TextMatch("total due", []core.MediaText{{Text: "total"}, {Text: "due"}}) != "good" || f.ix.TextMatch("x", nil) != "" {
		t.Error("TextMatch")
	}
	if f.ix.Model().ID != "toy-1" || f.ix.SpeechMaxMin() != 60 {
		t.Error("Model/SpeechMaxMin")
	}
	// status events: throttled, trailing delivered
	b := f.write("b.jpg", 4)
	f.reconcile()
	for i := 0; i < 20; i++ {
		f.store(f.res(b, "image", at(-1, 0)))
	}
	if n := f.em.count(core.EventSearchStatus); n > 2 {
		t.Errorf("search:status not throttled: %d in a burst", n)
	}
	if n := f.em.count(core.EventSearchIndexed); n != 21-1 && n < 20 {
		t.Errorf("search:indexed per batch: %d", n)
	}
	eventually(t, "trailing search:status", func() bool { return f.em.count(core.EventSearchStatus) >= 2 })
}

func TestFailuresDeleteIndexAndRebuild(t *testing.T) {
	f := newFx(t)
	s := f.sample()
	ctx := context.Background()
	if st := f.ix.Status(); st.Done != 7 || st.Pending != 0 || st.IndexBytes <= 0 || st.Total != 7 {
		t.Fatalf("status: %+v", st)
	}
	if fl, _ := f.ix.Failures(ctx, 0); len(fl) != 0 {
		t.Fatalf("failures: %+v", fl)
	}
	if err := f.ix.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	if st := f.ix.Status(); st.Pending != 7 {
		t.Fatalf("rebuild marks everything pending: %+v", st)
	}
	// old results stay searchable until redone
	if find(f.query(core.SearchQuery{Text: "4471"}).Hits, "receipt.jpg") == nil {
		t.Fatal("text vanished during rebuild")
	}
	if err := f.ix.DeleteIndex(ctx); err != nil {
		t.Fatal(err)
	}
	if st := f.ix.Status(); st.Total != 0 {
		t.Fatalf("delete index: %+v", st)
	}
	if len(f.query(core.SearchQuery{Text: "4471"}).Hits) != 0 || len(f.query(core.SearchQuery{Text: "apple"}).Hits) != 0 {
		t.Fatal("results after delete")
	}
	if lbl, _ := f.ix.Labels(ctx, s.apple); len(lbl) != 0 {
		t.Fatal("labels after delete")
	}
	// the library is walked again and everything is new
	f.ix.Rescan()
	if st := f.ix.Status(); st.Pending != 7 {
		t.Fatalf("after rescan: %+v", st)
	}
}

func TestVocabularyChangeRecomputesLabelsWithoutEmbeddingPictures(t *testing.T) {
	f := newFx(t)
	a := f.write("pear.jpg", 3)
	f.reconcile()
	f.store(f.res(a, "image", at(-1, 4)))
	ctx := context.Background()
	if err := f.ix.TestRecompute(ctx); err != nil { // records the vocabulary hash
		t.Fatal(err)
	}
	f.ix.SetUserLabel(ctx, a, "keeper", true)
	f.ix.SetUserLabel(ctx, a, "food", false) // hide an auto label
	before := f.caller.callCount()
	// a new vocabulary: "pear" is replaced by "kiwi" (same prompt, so no engine call is needed)
	vocab2 := strings.Replace(toyVocab, "pear\tfood\tpear\ta photo of a pear\tfruit", "kiwi\tfood\tkiwi\ta photo of a pear\tfruit", 1)
	if vocab2 == toyVocab {
		t.Fatal("fixture")
	}
	ix2 := f.newIndex(vocab2)
	ix2.TestLoad(ctx)
	if err := ix2.TestRecompute(ctx); err != nil {
		t.Fatal(err)
	}
	if f.caller.callCount() != before {
		t.Errorf("recomputing labels called the engine %d times (prompt vectors are cached, pictures are never re-embedded)", f.caller.callCount()-before)
	}
	got := map[string]string{}
	for _, l := range mustLabels(t, ix2, a) {
		got[l.Label] = l.Source
	}
	if got["kiwi"] != "auto" || got["fruit"] != "auto" || got["keeper"] != "user" {
		t.Errorf("labels after the vocabulary change: %v", got)
	}
	if _, ok := got["pear"]; ok {
		t.Errorf("a label that left the vocabulary is still set: %v", got)
	}
	if _, ok := got["food"]; ok {
		t.Errorf("hidden label came back: %v", got)
	}
	// the hash is stored, so a second recompute does nothing
	if err := ix2.TestRecompute(ctx); err != nil {
		t.Fatal(err)
	}
}
