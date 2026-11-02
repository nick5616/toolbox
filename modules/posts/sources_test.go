package posts

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/modules/composer"
	"toolbox/modules/videoeditor"
)

// exifWithDate builds an Exif payload whose Exif IFD holds DateTimeOriginal.
func exifWithDate(date string) []byte {
	le := binary.LittleEndian
	var t bytes.Buffer
	t.WriteString("II")
	t.Write(le.AppendUint16(nil, 42))
	t.Write(le.AppendUint32(nil, 8))
	t.Write(le.AppendUint16(nil, 1)) // one IFD0 entry: Exif pointer
	t.Write(le.AppendUint16(nil, tagExifPointer))
	t.Write(le.AppendUint16(nil, 4))
	t.Write(le.AppendUint32(nil, 1))
	exifIFD := uint32(8 + 2 + 12 + 4)
	t.Write(le.AppendUint32(nil, exifIFD))
	t.Write(le.AppendUint32(nil, 0))
	t.Write(le.AppendUint16(nil, 1))
	t.Write(le.AppendUint16(nil, tagDateOrig))
	t.Write(le.AppendUint16(nil, 2)) // ASCII
	t.Write(le.AppendUint32(nil, 20))
	t.Write(le.AppendUint32(nil, exifIFD+2+12+4))
	t.Write(le.AppendUint32(nil, 0))
	t.WriteString(date)
	t.WriteByte(0)
	return append(append([]byte(nil), exifHeader...), t.Bytes()...)
}

func touch(t *testing.T, path string, mod time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func names(src []SourceFile) []string {
	out := []string{}
	for _, s := range src {
		out = append(out, s.Rel+"|"+s.Name)
	}
	return out
}

func (e *testEnv) sources(id string) ([]SourceFile, error) {
	return NewService(nil, e.m).Sources(id)
}

func TestSourcesWalkFlagsHiddenExtra(t *testing.T) {
	e := newEnv(t)
	root := t.TempDir()
	base := time.Date(2026, 5, 1, 10, 0, 0, 0, time.Local)
	touch(t, filepath.Join(root, "b.jpg"), base.Add(2*time.Hour))
	touch(t, filepath.Join(root, "a.mp4"), base.Add(time.Hour))
	touch(t, filepath.Join(root, "notes.txt"), base)
	touch(t, filepath.Join(root, "sub", "c.png"), base)
	touch(t, filepath.Join(root, ".hid", "d.jpg"), base)
	extraDir := t.TempDir()
	ex := filepath.Join(extraDir, "e.heic")
	touch(t, ex, base.Add(3*time.Hour))
	gone := filepath.Join(extraDir, "gone.jpg")

	doc := Post{Version: 1, Format: "carousel", Aspect: "4:5", Slides: []Slide{}, Folder: root, Subfolders: false, Extra: []string{ex, gone}}
	id := e.save("p", doc)
	got, err := e.sources(id)
	if err != nil {
		t.Fatal(err)
	}
	// gone.jpg has TakenAt 0 so it sorts first
	want := []string{"|gone.jpg", "a.mp4|a.mp4", "b.jpg|b.jpg", "|e.heic"}
	if !slices.Equal(names(got), want) {
		t.Fatalf("flat: %v", names(got))
	}
	if !got[0].Missing || got[0].Kind != "photo" || got[1].Kind != "clip" || got[3].Kind != "photo" {
		t.Fatalf("kinds/missing: %+v", got)
	}
	for _, s := range got {
		if s.UsedIn == nil {
			t.Fatal("UsedIn must be non-nil")
		}
	}

	doc.Subfolders = true
	doc.Hidden = []string{filepath.Join(root, "a.mp4")}
	doc.Extra = []string{ex}
	if _, err := e.m.docs.Save(context.Background(), id, "p", doc); err != nil {
		t.Fatal(err)
	}
	got, _ = e.sources(id)
	rel := filepath.Join("sub", "c.png")
	// c.png (base) < b.jpg < e.heic; hidden a.mp4 and .hid are gone.
	want = []string{rel + "|c.png", "b.jpg|b.jpg", "|e.heic"}
	if !slices.Equal(names(got), want) {
		t.Fatalf("deep: %v", names(got))
	}
}

func TestSourcesExifDateWins(t *testing.T) {
	e := newEnv(t)
	root := t.TempDir()
	writeJPEG(t, filepath.Join(root, "late.jpg"), image.NewNRGBA(image.Rect(0, 0, 8, 8)), exifWithDate("2020:01:02 03:04:05"))
	touch(t, filepath.Join(root, "early.jpg"), time.Date(2024, 1, 1, 0, 0, 0, 0, time.Local))
	id := e.save("p", Post{Version: 1, Format: "carousel", Aspect: "4:5", Folder: root})
	got, err := e.sources(id)
	if err != nil {
		t.Fatal(err)
	}
	// The EXIF date (2020) sorts before the 2024 mtime even though late.jpg is alphabetically later.
	if got[0].Name != "late.jpg" {
		t.Fatalf("order: %v", names(got))
	}
	if want := time.Date(2020, 1, 2, 3, 4, 5, 0, time.Local).UnixMilli(); got[0].TakenAt != want {
		t.Fatalf("TakenAt %d, want %d", got[0].TakenAt, want)
	}
}

func TestSources500Fast(t *testing.T) {
	e := newEnv(t)
	root := t.TempDir()
	base := time.Date(2026, 5, 1, 0, 0, 0, 0, time.Local)
	img := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for i := 0; i < 500; i++ {
		dir := root
		if i%5 == 0 {
			dir = filepath.Join(root, fmt.Sprintf("d%d", i%7))
		}
		p := filepath.Join(dir, fmt.Sprintf("img%03d.jpg", i))
		if i%2 == 0 {
			os.MkdirAll(dir, 0o755)
			writeJPEG(t, p, img, exifWithDate(base.Add(time.Duration(500-i)*time.Minute).Format(exifDateLayout)))
		} else {
			touch(t, p, base.Add(time.Duration(i)*time.Minute))
		}
	}
	id := e.save("p", Post{Version: 1, Format: "carousel", Aspect: "4:5", Folder: root, Subfolders: true})
	start := time.Now()
	got, err := e.sources(id)
	el := time.Since(start)
	t.Logf("Sources(500) took %v", el)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 500 {
		t.Fatalf("len %d", len(got))
	}
	if el > time.Second {
		t.Fatalf("Sources took %v", el)
	}
	if !slices.IsSortedFunc(got, func(a, b SourceFile) int {
		switch {
		case a.TakenAt < b.TakenAt:
			return -1
		case a.TakenAt > b.TakenAt:
			return 1
		}
		return 0
	}) {
		t.Fatal("not sorted by TakenAt")
	}
}

func TestSourcesMissingFolder(t *testing.T) {
	e := newEnv(t)
	id := e.save("p", Post{Version: 1, Format: "carousel", Aspect: "4:5", Folder: filepath.Join(t.TempDir(), "nope")})
	got, err := e.sources(id)
	var ae *core.AppError
	if !asAppError(err, &ae) || ae.Message != "The source folder isn't there any more" || ae.Hint != "Choose it again" {
		t.Fatalf("err %v", err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("pool %v", got)
	}
}

func TestSourcesUsageAndCheckNote(t *testing.T) {
	e := newEnv(t)
	root := t.TempDir()
	now := time.Now()
	for _, n := range []string{"a.jpg", "b.jpg", "c.jpg", "d.mp4", "e.jpg", "song.jpg", "f.jpg"} {
		touch(t, filepath.Join(root, n), now)
	}
	p := func(n string) string { return filepath.Join(root, n) }
	e.m.comps = &fakeComps{comp: composer.Composition{
		Background: composer.Background{Kind: "image", Image: &composer.ImageRef{Path: p("b.jpg")}},
		Layers: []composer.Layer{
			{ID: "l1", Kind: "image", Image: &composer.ImageLayer{Ref: composer.ImageRef{Path: "cutout.png", Original: p("c.jpg")}}},
			{ID: "l2", Kind: "text"},
		},
	}, render: "x"}
	e.m.videos = &fakeVideos{doc: videoeditor.VideoProject{
		Clips: []videoeditor.Clip{{Path: p("d.mp4")}, {Path: p("a.jpg")}},
		Music: &videoeditor.Music{Path: p("e.jpg")},
	}}
	doc := Post{Version: 1, Format: "carousel", Aspect: "4:5", Folder: root, Slides: []Slide{
		{ID: "s1", Kind: "photo", Path: p("a.jpg"), Zoom: 1},
		{ID: "s2", Kind: "composition", ProjectID: "comp"},
		{ID: "s3", Kind: "video", ProjectID: "vid"},
	}}
	id := e.save("p", doc)
	got, err := e.sources(id)
	if err != nil {
		t.Fatal(err)
	}
	used := map[string][]string{}
	for _, s := range got {
		used[s.Name] = s.UsedIn
	}
	check := map[string][]string{
		"a.jpg": {"s1", "s3"}, "b.jpg": {"s2"}, "c.jpg": {"s2"}, "d.mp4": {"s3"}, "e.jpg": {"s3"}, "f.jpg": {}, "song.jpg": {},
	}
	for n, want := range check {
		if !slices.Equal(used[n], want) {
			t.Errorf("%s used in %v, want %v", n, used[n], want)
		}
	}
	var note *Issue
	for _, is := range e.m.Check(context.Background(), doc) {
		if is.Level == LevelNote && is.SlideID == "" {
			is := is
			note = &is
		}
	}
	if note == nil || note.Message != "2 sources aren't used in any slide" {
		t.Fatalf("note %+v", note)
	}
}

func TestCreateFromFolder(t *testing.T) {
	e := newEnv(t)
	lib := t.TempDir()
	e.m.cfg.LibraryDir = func() string { return lib }
	s := NewService(nil, e.m)
	root := t.TempDir()
	file := filepath.Join(root, "f.jpg")
	touch(t, file, time.Now())
	inLib := filepath.Join(lib, "Posts")
	os.MkdirAll(inLib, 0o755)

	bad := []struct{ name, format, aspect, folder string }{
		{"relative", "carousel", "4:5", "photos"},
		{"missing", "carousel", "4:5", filepath.Join(root, "nope")},
		{"file", "carousel", "4:5", file},
		{"library", "carousel", "4:5", inLib},
		{"library root", "carousel", "4:5", lib},
		{"format", "poster", "4:5", root},
		{"aspect", "carousel", "2:1", root},
	}
	for _, c := range bad {
		if _, err := s.CreateFromFolder("x", c.format, c.aspect, c.folder, false); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%s: err %v", c.name, err)
		}
	}
	info, err := s.CreateFromFolder("Trip", "story", "4:5", root, true)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := s.Get(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Folder != filepath.Clean(root) || !doc.Subfolders || doc.Aspect != "9:16" || len(doc.Slides) != 0 {
		t.Fatalf("doc %+v", doc)
	}
}

func TestSaveValidatesPool(t *testing.T) {
	e := newEnv(t)
	s := NewService(nil, e.m)
	info, err := s.CreateFromFolder("T", "carousel", "4:5", t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := s.Get(info.ID)
	abs := filepath.Join(t.TempDir(), "x.jpg")
	cases := map[string]func(*Post){
		"folder": func(p *Post) { p.Folder = "rel" },
		"extra":  func(p *Post) { p.Extra = []string{"rel.jpg"} },
		"hidden": func(p *Post) { p.Hidden = []string{"rel.jpg"} },
		"many": func(p *Post) {
			for range maxPoolEntries + 1 {
				p.Extra = append(p.Extra, abs)
			}
		},
	}
	for name, mod := range cases {
		d := doc
		d.Extra, d.Hidden = nil, nil
		mod(&d)
		if _, err := s.Save(info.ID, "T", d); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%s: %v", name, err)
		}
	}
	doc.Extra, doc.Hidden, doc.Folder = []string{abs}, []string{abs}, ""
	if _, err := s.Save(info.ID, "T", doc); err != nil {
		t.Fatal(err)
	}
}

func TestOldDocumentsLoad(t *testing.T) {
	e := newEnv(t)
	id := e.save("old", Post{Version: 1, Format: "carousel", Aspect: "4:5", Slides: []Slide{}})
	s := NewService(nil, e.m)
	doc, err := s.Get(id)
	if err != nil || doc.Folder != "" {
		t.Fatal(err, doc)
	}
	got, err := s.Sources(id)
	if err != nil || len(got) != 0 {
		t.Fatal(err, got)
	}
	if n := e.m.unusedSources(context.Background(), doc); n != 0 {
		t.Fatal(n)
	}
}
