package posts

import (
	"context"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/modules/composer"
	"toolbox/modules/videoeditor"
)

func TestCropWindow(t *testing.T) {
	cases := []struct {
		name                   string
		w, h, aspect, zoom     float64
		panX, panY             float64
		wantX, wantY, wantW, H float64
	}{
		{"landscape to 4:5 centred", 4000, 3000, 0.8, 1, 0, 0, 800, 0, 2400, 3000},
		{"landscape to 4:5 pan left", 4000, 3000, 0.8, 1, -1, 0, 0, 0, 2400, 3000},
		{"landscape to 4:5 pan right", 4000, 3000, 0.8, 1, 1, 0, 1600, 0, 2400, 3000},
		{"portrait to 1:1", 3000, 4000, 1, 1, 0, 1, 0, 1000, 3000, 3000},
		{"zoom 2 centred", 4000, 3000, 0.8, 2, 0, 0, 1400, 750, 1200, 1500},
		{"same aspect no crop", 1080, 1350, 0.8, 1, 0.7, -0.4, 0, 0, 1080, 1350},
		{"pan clamps", 4000, 3000, 0.8, 1, 5, -5, 1600, 0, 2400, 3000},
		{"wide frame 1.91", 3000, 3000, 1080.0 / 566, 1, 0, 0, 0, 714.5, 3000, 1572},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x, y, w, h := cropWindow(c.w, c.h, c.aspect, c.zoom, c.panX, c.panY)
			near := func(a, b float64) bool { return a-b < 1.5 && b-a < 1.5 }
			if !near(x, c.wantX) || !near(y, c.wantY) || !near(w, c.wantW) || !near(h, c.H) {
				t.Errorf("got %.1f %.1f %.1f %.1f, want %.1f %.1f %.1f %.1f", x, y, w, h, c.wantX, c.wantY, c.wantW, c.H)
			}
		})
	}
}

func TestClipFilter(t *testing.T) {
	got := clipFilter(90, 0.5, -1, 2, 1080, 1350)
	want := "transpose=1,scale=2160:2700:force_original_aspect_ratio=increase:flags=lanczos," +
		"crop=1080:1350:x='(iw-ow)*(1+0.5000)/2':y='(ih-oh)*(1+-1.0000)/2',fps=30,format=yuv420p,setsar=1"
	if got != want {
		t.Errorf("filter\n got %s\nwant %s", got, want)
	}
	args := strings.Join(clipArgs("a.mp4", "o.mp4", 1000, 61000, 0, 0, 0, 1, true, false, 1080, 1350), " ")
	for _, w := range []string{"-ss 1.000", "-t 60.000", "-an", "-map_metadata -1", "-crf 19", "+faststart"} {
		if !strings.Contains(args, w) {
			t.Errorf("args missing %q: %s", w, args)
		}
	}
	kept := strings.Join(clipArgs("a.mp4", "o.mp4", 0, 5000, 0, 0, 0, 1, false, true, 1080, 1350), " ")
	if strings.Contains(kept, "map_metadata") || !strings.Contains(kept, "aac -b:a 192k -ar 48000") {
		t.Errorf("kept args: %s", kept)
	}
}

func TestRotateImage(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	img.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 255}) // top-left red
	for _, c := range []struct {
		deg         int
		w, h        int
		rx, ry      int // where the red pixel lands
		wantRedAt   bool
		description string
	}{
		{90, 2, 3, 1, 0, true, "top-left goes to top-right"},
		{180, 3, 2, 2, 1, true, "top-left goes to bottom-right"},
		{270, 2, 3, 0, 2, true, "top-left goes to bottom-left"},
	} {
		out := rotateImage(img, c.deg)
		if out.Bounds().Dx() != c.w || out.Bounds().Dy() != c.h {
			t.Fatalf("%d: size %v", c.deg, out.Bounds())
		}
		r, _, _, _ := out.At(c.rx, c.ry).RGBA()
		if r == 0 {
			t.Errorf("%d: %s: red not found", c.deg, c.description)
		}
	}
}

func TestExifHelpers(t *testing.T) {
	dir := t.TempDir()
	withGPS := filepath.Join(dir, "gps.jpg")
	noGPS := filepath.Join(dir, "plain.jpeg")
	writeJPEG(t, withGPS, gradient(40, 30), exifPayload(6, true))
	writeJPEG(t, noGPS, gradient(40, 30), exifPayload(1, false))
	if !hasGPS(withGPS) || hasGPS(noGPS) {
		t.Error("hasGPS wrong")
	}
	seg, ok := readExifSegment(withGPS)
	if !ok {
		t.Fatal("no exif")
	}
	reset := resetOrientation(seg)
	if len(reset) != len(seg) || reset[len(exifHeader)+10+8] != 1 {
		t.Errorf("orientation not reset")
	}
	if seg[len(exifHeader)+10+8] != 6 {
		t.Error("resetOrientation modified its input")
	}
}

func TestMakeFolderAndNames(t *testing.T) {
	e := newEnv(t)
	for i, want := range []string{"Trip 2026-11-01", "Trip 2026-11-01 (2)", "Trip 2026-11-01 (3)"} {
		p, err := e.m.makeFolder(e.outDir, "Trip")
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(p) != want {
			t.Errorf("%d: got %q want %q", i, filepath.Base(p), want)
		}
	}
	if got := cleanFolderName(` a/b:c?  "d". `); got != "a b c d" {
		t.Errorf("clean name %q", got)
	}
	if cleanFolderName("..") != "Post" {
		t.Error("empty name fallback")
	}
}

// checkEnv builds a post of photo slides over real files.
func checkPhotos(t *testing.T, n int, w, h int) (Post, string) {
	dir := t.TempDir()
	doc := Post{Version: 1, Format: "carousel", Aspect: "4:5"}
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, "p"+string(rune('a'+i))+".png")
		writePNG(t, p, gradient(w, h))
		doc.Slides = append(doc.Slides, Slide{ID: p, Kind: "photo", Path: p, Zoom: 1})
	}
	return doc, dir
}

func has(issues []Issue, level, sub string) bool {
	for _, i := range issues {
		if i.Level == level && strings.Contains(i.Message, sub) {
			return true
		}
	}
	return false
}

func TestCheck(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if got := e.m.Check(ctx, Post{}); got == nil || !has(got, "error", "at least one slide") {
		t.Errorf("empty post: %v", got)
	}

	ok, dir := checkPhotos(t, 1, 1200, 1500)
	if got := e.m.Check(ctx, ok); got == nil || len(got) != 0 {
		t.Errorf("clean post should have no issues: %v", got)
	}

	t.Run("too many slides", func(t *testing.T) {
		d := ok
		d.Slides = nil
		for i := 0; i < 21; i++ {
			s := ok.Slides[0]
			s.ID = string(rune('A' + i))
			d.Slides = append(d.Slides, s)
		}
		if !has(e.m.Check(ctx, d), "error", "at most 20") {
			t.Error("missing too-many error")
		}
	})
	t.Run("reel", func(t *testing.T) {
		d := ok
		d.Format, d.Aspect = "reel", "9:16"
		if !has(e.m.Check(ctx, d), "error", "reel is exactly one video") {
			t.Error("a photo reel should error")
		}
	})
	t.Run("missing source", func(t *testing.T) {
		d := Post{Format: "carousel", Aspect: "4:5", Slides: []Slide{{ID: "x", Kind: "photo", Path: filepath.Join(dir, "gone.jpg"), Zoom: 1}}}
		got := e.m.Check(ctx, d)
		if !has(got, "error", "missing") || got[0].SlideID != "x" {
			t.Errorf("%v", got)
		}
	})
	t.Run("caption", func(t *testing.T) {
		d := ok
		d.Caption = strings.Repeat("é", 2201)
		if !has(e.m.Check(ctx, d), "error", "2201 characters") {
			t.Error("caption length counts characters")
		}
		d.Caption = strings.Repeat("é", 2200)
		if has(e.m.Check(ctx, d), "error", "caption") {
			t.Error("2200 characters is allowed")
		}
	})
	t.Run("hashtags and mentions", func(t *testing.T) {
		d := ok
		d.Caption = strings.Repeat("#viaje #été_2026 ", 16) // 32
		if !has(e.m.Check(ctx, d), "error", "32 hashtags") {
			t.Errorf("hashtags: %v", e.m.Check(ctx, d))
		}
		d.Caption = strings.Repeat("@a.b_c ", 21) + "mail me at x@y.com"
		got := e.m.Check(ctx, d)
		if !has(got, "warning", "21 @mentions") {
			t.Errorf("mentions: %v", got)
		}
	})
	t.Run("3:4 note", func(t *testing.T) {
		d := ok
		d.Aspect = "3:4"
		if !has(e.m.Check(ctx, d), "note", "3:4 is new") {
			t.Error("missing note")
		}
	})
	t.Run("soft", func(t *testing.T) {
		small, _ := checkPhotos(t, 1, 800, 1000)
		if !has(e.m.Check(ctx, small), "warning", "may look soft") {
			t.Error("800 px wide should warn")
		}
		// zoom 2 on a 1500 px wide source: window 600 px
		d := ok
		d.Slides = append([]Slide(nil), ok.Slides...)
		d.Slides[0].Zoom = 2
		if !has(e.m.Check(ctx, d), "warning", "may look soft") {
			t.Error("zoom should shrink the window")
		}
	})
	t.Run("gps", func(t *testing.T) {
		p := filepath.Join(t.TempDir(), "g.jpg")
		writeJPEG(t, p, gradient(1200, 1500), exifPayload(1, true))
		d := Post{Format: "carousel", Aspect: "4:5", Slides: []Slide{{ID: "g", Kind: "photo", Path: p, Zoom: 1}}}
		if !has(e.m.Check(ctx, d), "note", "Location will be removed") {
			t.Error("missing note")
		}
		d.KeepLocation = true
		if has(e.m.Check(ctx, d), "note", "Location") {
			t.Error("note shown with KeepLocation")
		}
	})
	t.Run("heic needs engine", func(t *testing.T) {
		p := filepath.Join(t.TempDir(), "IMG.HEIC")
		os.WriteFile(p, []byte("x"), 0o644)
		d := Post{Format: "carousel", Aspect: "4:5", Slides: []Slide{{ID: "h", Kind: "photo", Path: p, Zoom: 1}}}
		if !has(e.m.Check(ctx, d), "error", "AI engine") {
			t.Error("missing engine error")
		}
		e.tools["audio-engine"] = "/engine"
		if has(e.m.Check(ctx, d), "error", "AI engine") {
			t.Error("engine present should pass")
		}
	})
	t.Run("clip too long", func(t *testing.T) {
		p := filepath.Join(t.TempDir(), "c.mp4")
		os.WriteFile(p, []byte("x"), 0o644)
		d := Post{Format: "carousel", Aspect: "4:5", Slides: []Slide{{ID: "c", Kind: "clip", Path: p, OutMs: 61_000, Zoom: 1}}}
		if !has(e.m.Check(ctx, d), "error", "limit is 60 s") {
			t.Error("61 s clip should error in a carousel")
		}
		d.Format, d.Aspect = "reel", "9:16"
		if has(e.m.Check(ctx, d), "error", "limit is") {
			t.Error("61 s clip is fine in a reel")
		}
	})
	t.Run("composition and video", func(t *testing.T) {
		render := filepath.Join(t.TempDir(), "r.png")
		writePNG(t, render, gradient(10, 10))
		e.m.comps = &fakeComps{comp: composer.Composition{Aspect: "1:1"}, render: render}
		e.m.videos = &fakeVideos{doc: videoeditor.VideoProject{Aspect: "16:9"}}
		d := Post{Format: "carousel", Aspect: "4:5", Slides: []Slide{
			{ID: "c", Kind: "composition", ProjectID: "x", Zoom: 1}, {ID: "v", Kind: "video", ProjectID: "y", Zoom: 1}}}
		got := e.m.Check(ctx, d)
		if !has(got, "warning", "framed to fit 4:5") || len(got) != 2 {
			t.Errorf("%v", got)
		}
		e.m.comps = &fakeComps{err: errFake}
		if !has(e.m.Check(ctx, d), "error", "composition is missing") {
			t.Error("missing composition")
		}
	})
}

func TestSaveValidation(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	info, err := svc.Create("Trip", "reel", "4:5", nil)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := svc.Get(info.ID)
	if doc.Aspect != "9:16" || doc.Format != "reel" {
		t.Errorf("reel must force 9:16: %+v", doc)
	}
	if _, err := svc.Create("x", "carousel", "9:16", nil); err == nil {
		t.Error("a 9:16 carousel should be refused")
	}
	if _, err := svc.Create("x", "poster", "4:5", nil); err == nil {
		t.Error("unknown format")
	}

	good := Post{Format: "carousel", Aspect: "4:5", Caption: strings.Repeat("x", 5000), Slides: []Slide{{ID: "a", Kind: "photo", Path: "/p.jpg", Zoom: 1}}}
	if _, err := svc.Save(info.ID, "Trip", good); err != nil {
		t.Errorf("a too-long caption must still save: %v", err)
	}
	if got, _ := svc.Get(info.ID); len(got.Caption) != 5000 || got.Version != 1 {
		t.Errorf("stored %d chars, version %d", len(got.Caption), got.Version)
	}
	good.Slides[0].Zoom = 9
	if _, err := svc.Save(info.ID, "Trip", good); err == nil {
		t.Error("zoom 9 should be refused")
	}
}

func TestSaveShapeRules(t *testing.T) {
	base := func() Post {
		return Post{Version: 1, Format: "carousel", Aspect: "4:5", Slides: []Slide{{ID: "a", Kind: "photo", Path: "/p.jpg", Zoom: 1}}}
	}
	if err := validateShape(base()); err != nil {
		t.Fatal(err)
	}
	long := base()
	long.Caption = strings.Repeat("x", 5000) // stored even when too long
	if err := validateShape(long); err != nil {
		t.Errorf("long caption must not block saving: %v", err)
	}
	mut := map[string]func(*Post){
		"pan":        func(p *Post) { p.Slides[0].PanX = 1.5 },
		"zoom low":   func(p *Post) { p.Slides[0].Zoom = 0.5 },
		"zoom high":  func(p *Post) { p.Slides[0].Zoom = 4.5 },
		"rotation":   func(p *Post) { p.Slides[0].Rotation = 45 },
		"kind":       func(p *Post) { p.Slides[0].Kind = "gif" },
		"empty id":   func(p *Post) { p.Slides[0].ID = "" },
		"dup id":     func(p *Post) { p.Slides = append(p.Slides, p.Slides[0]) },
		"clip range": func(p *Post) { p.Slides[0].Kind, p.Slides[0].InMs, p.Slides[0].OutMs = "clip", 5, 5 },
		"alt":        func(p *Post) { p.Slides[0].AltText = strings.Repeat("a", 1001) },
		"aspect":     func(p *Post) { p.Aspect = "9:16" },
		"story":      func(p *Post) { p.Format = "story" },
		"format":     func(p *Post) { p.Format = "x" },
		"no project": func(p *Post) { p.Slides[0].Kind, p.Slides[0].ProjectID = "video", "" },
	}
	for name, f := range mut {
		p := base()
		f(&p)
		if err := validateShape(p); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestCreateFromPaths(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	dir := t.TempDir()
	a := filepath.Join(dir, "a.png")
	writePNG(t, a, gradient(30, 20))
	txt := filepath.Join(dir, "n.txt")
	os.WriteFile(txt, []byte("x"), 0o644)
	info, err := svc.Create("Trip", "carousel", "1:1", []string{a, txt, filepath.Join(dir, "gone.jpg")})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := svc.Get(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Slides) != 1 || doc.Slides[0].Kind != "photo" || doc.Slides[0].Zoom != 1 || doc.Slides[0].ID == "" {
		t.Errorf("slides %+v", doc.Slides)
	}
	src, _ := svc.SlideInfo([]string{a, txt})
	if src[0].Width != 30 || src[0].Height != 20 || src[1].Kind != "" || src[1].Error == "" {
		t.Errorf("slide info %+v", src)
	}
	if _, err := svc.Save(info.ID, "Trip", doc); err != nil {
		t.Fatal(err)
	}
}

func TestPhotoExport(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "IMG_1.jpg")
	writeJPEG(t, src, gradient(4000, 3000), exifPayload(6, true))
	plain := filepath.Join(dir, "plain.png")
	writePNG(t, plain, gradient(1500, 1200))

	doc := Post{Version: 1, Format: "carousel", Aspect: "4:5", Caption: "Hello #market\nsecond line", Slides: []Slide{
		{ID: "a", Kind: "photo", Path: src, Zoom: 1, AltText: "A market"},
		{ID: "b", Kind: "photo", Path: plain, Zoom: 1.5, PanX: -1, Rotation: 90},
	}}
	id := e.save("Market: day 1", doc)
	if err := e.run(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	res := e.exportResult()
	if filepath.Base(res.Folder) != "Market day 1 2026-11-01" {
		t.Errorf("folder %q", res.Folder)
	}
	for _, n := range []string{"01.jpg", "02.jpg", "caption.txt", "alt-text.txt", "post.json"} {
		if _, err := os.Stat(filepath.Join(res.Folder, n)); err != nil {
			t.Errorf("missing %s", n)
		}
	}
	for _, n := range []string{"01.jpg", "02.jpg"} {
		if w, h := imageSize(t, filepath.Join(res.Folder, n)); w != 1080 || h != 1350 {
			t.Errorf("%s is %dx%d", n, w, h)
		}
	}
	data, _ := os.ReadFile(filepath.Join(res.Folder, "01.jpg"))
	if _, ok := findExifSegment(data); ok {
		t.Error("EXIF must be stripped by default")
	}
	if b, _ := os.ReadFile(filepath.Join(res.Folder, "caption.txt")); string(b) != doc.Caption {
		t.Errorf("caption %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(res.Folder, "alt-text.txt")); string(b) != "01: A market\n" {
		t.Errorf("alt text %q", b)
	}
	if len(e.outputs) != 4 { // 2 photos, caption, alt text; not post.json
		t.Errorf("registered %v", e.outputs)
	}
	for _, o := range e.outputs {
		if filepath.Base(o) == "post.json" {
			t.Error("post.json registered")
		}
	}

	// second export the same day, with location kept
	doc.KeepLocation = true
	id2 := e.save("Market: day 1", doc)
	e.outputs = nil
	if err := e.run(context.Background(), id2); err != nil {
		t.Fatal(err)
	}
	res2 := e.exportResult()
	if filepath.Base(res2.Folder) != "Market day 1 2026-11-01 (2)" {
		t.Errorf("second folder %q", res2.Folder)
	}
	data, _ = os.ReadFile(filepath.Join(res2.Folder, "01.jpg"))
	seg, ok := findExifSegment(data)
	if !ok {
		t.Fatal("EXIF should be kept")
	}
	if seg[len(exifHeader)+10+8] != 1 {
		t.Error("orientation must be reset to 1")
	}
	tiff := seg[len(exifHeader):]
	if !tiffHasGPS(bytesReader(tiff), int64(len(tiff))) {
		t.Error("GPS should be kept")
	}
	if w, h := imageSize(t, filepath.Join(res2.Folder, "01.jpg")); w != 1080 || h != 1350 {
		t.Errorf("kept-exif jpeg is %dx%d", w, h)
	}
	if _, err := os.Stat(filepath.Join(res2.Folder, "alt-text.txt")); err != nil {
		t.Error("alt-text.txt expected")
	}
}

func TestOrientationApplied(t *testing.T) {
	probe := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	if o := imaging.Orient(probe, 6); o.Bounds().Dx() != 2 {
		t.Skip("imaging.Orient is not implemented in this tree yet")
	}
	e := newEnv(t)
	src := filepath.Join(t.TempDir(), "o6.jpg")
	// stored landscape with orientation 6 -> displayed portrait
	writeJPEG(t, src, gradient(400, 300), exifPayload(6, false))
	w, h, err := orientedSize(src)
	if err != nil || w != 300 || h != 400 {
		t.Errorf("orientedSize %d %d %v", w, h, err)
	}
	_ = e
}

func TestExportNoAltTextFile(t *testing.T) {
	e := newEnv(t)
	doc, _ := checkPhotos(t, 1, 1100, 1400)
	id := e.save("Plain", doc)
	if err := e.run(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	res := e.exportResult()
	if _, err := os.Stat(filepath.Join(res.Folder, "alt-text.txt")); err == nil {
		t.Error("alt-text.txt should be omitted")
	}
}

func TestExportFailureRemovesFolder(t *testing.T) {
	e := newEnv(t)
	doc, _ := checkPhotos(t, 1, 1100, 1400)
	id := e.save("Fails", doc)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.run(ctx, id); err == nil {
		t.Fatal("cancelled export should fail")
	}
	entries, _ := os.ReadDir(e.outDir)
	if len(entries) != 0 {
		t.Errorf("leftover folders: %v", entries)
	}

	// Check errors refuse to run.
	bad := e.save("Bad", Post{Format: "carousel", Aspect: "4:5"})
	err := e.run(context.Background(), bad)
	var ae *core.AppError
	if err == nil || !asAppError(err, &ae) || ae.Code != core.CodeValidation {
		t.Errorf("want validation error, got %v", err)
	}
}

func TestCompositionAndVideoExport(t *testing.T) {
	e := newEnv(t)
	render := filepath.Join(t.TempDir(), "comp.png")
	writePNG(t, render, gradient(1080, 1920))
	e.m.comps = &fakeComps{comp: composer.Composition{Aspect: "9:16", Format: "png"}, render: render}
	fv := &fakeVideos{doc: videoeditor.VideoProject{Aspect: "9:16"}, render: func(out string, _ videoeditor.RenderOptions) error {
		return os.WriteFile(out, []byte("mp4"), 0o644)
	}}
	e.m.videos = fv
	doc := Post{Version: 1, Format: "story", Aspect: "9:16", Slides: []Slide{
		{ID: "c", Kind: "composition", ProjectID: "c1", Zoom: 1},
		{ID: "v", Kind: "video", ProjectID: "v1", Zoom: 1},
	}}
	id := e.save("Story", doc)
	if err := e.run(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	res := e.exportResult()
	if w, h := imageSize(t, filepath.Join(res.Folder, "01.png")); w != 1080 || h != 1920 {
		t.Errorf("composition png %dx%d", w, h)
	}
	if b, err := os.ReadFile(filepath.Join(res.Folder, "02.mp4")); err != nil || string(b) != "mp4" {
		t.Errorf("video not moved: %v", err)
	}
	if fv.opts.Width != 1080 || fv.opts.Height != 1920 || fv.opts.MaxSeconds != 60 {
		t.Errorf("render options %+v", fv.opts)
	}

	// carousel composition goes out as JPEG
	doc.Format, doc.Aspect = "carousel", "4:5"
	doc.Slides = doc.Slides[:1]
	id = e.save("Car", doc)
	if err := e.run(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	res = e.exportResult()
	if w, h := imageSize(t, filepath.Join(res.Folder, "01.jpg")); w != 1080 || h != 1350 {
		t.Errorf("composition jpg %dx%d", w, h)
	}
}

func TestValidate(t *testing.T) {
	e := newEnv(t)
	if err := e.m.Validate(nil, []byte(`{"action":"export","projectId":"x"}`)); err != nil {
		t.Error(err)
	}
	for _, bad := range []string{`{"action":"export"}`, `{"action":"nope","projectId":"x"}`, `{"bogus":1}`} {
		if e.m.Validate(nil, []byte(bad)) == nil {
			t.Errorf("%s should fail", bad)
		}
	}
}
