package paint

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/core/store"
)

// --- helpers ---------------------------------------------------------------

type env struct {
	m       *Module
	support string
	library string
}

func setup(t *testing.T) *env {
	t.Helper()
	root := t.TempDir()
	db, err := store.Open(filepath.Join(root, "toolbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := &env{support: root, library: filepath.Join(root, "Library")}
	e.m = New(Config{
		Store: db, ProjectsDir: filepath.Join(root, "projects"), SupportDir: root, TmpDir: filepath.Join(root, "tmp"),
		LibraryDir: func() string { return e.library },
	})
	return e
}

func solid(w, h int, c color.NRGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	return img
}

func pngBytes(t *testing.T, img image.Image) []byte {
	t.Helper()
	b, err := encodePNG(img)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func writePNG(t *testing.T, path string, img image.Image) {
	t.Helper()
	if err := os.WriteFile(path, pngBytes(t, img), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readPNG(t *testing.T, path string) *image.NRGBA {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return toNRGBA(img)
}

func px(img *image.NRGBA, x, y int) color.NRGBA { return img.NRGBAAt(x, y) }

func near(a, b color.NRGBA, tol int) bool {
	d := func(x, y uint8) int {
		if x > y {
			return int(x - y)
		}
		return int(y - x)
	}
	return d(a.R, b.R) <= tol && d(a.G, b.G) <= tol && d(a.B, b.B) <= tol && d(a.A, b.A) <= tol
}

// paintTile stores a solid tile image on a layer through the public path.
func (e *env) paintLayer(t *testing.T, id, layerID string, w, h int, c color.NRGBA) []string {
	t.Helper()
	dir, err := e.m.layerDir(id, layerID)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := writeImageTiles(dir, solid(w, h, c), image.Point{}, w, h)
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

// --- document validation ---------------------------------------------------

func TestValidateDoc(t *testing.T) {
	good := func() PaintDoc { return newDoc(100, 80, "#ffffff") }
	cases := []struct {
		name string
		mut  func(d *PaintDoc)
		ok   bool
	}{
		{"valid", func(d *PaintDoc) {}, true},
		{"transparent", func(d *PaintDoc) { d.Background = "transparent" }, true},
		{"bad version", func(d *PaintDoc) { d.Version = 2 }, false},
		{"zero width", func(d *PaintDoc) { d.Width = 0 }, false},
		{"too wide", func(d *PaintDoc) { d.Width = MaxSide + 1 }, false},
		{"too many pixels", func(d *PaintDoc) { d.Width, d.Height = 8000, 6000 }, false},
		{"max pixels", func(d *PaintDoc) { d.Width, d.Height = 8000, 5000 }, true},
		{"bad background", func(d *PaintDoc) { d.Background = "red" }, false},
		{"bad tile size", func(d *PaintDoc) { d.TileSize = 256 }, false},
		{"no layers", func(d *PaintDoc) { d.Layers = nil }, false},
		{"too many layers", func(d *PaintDoc) {
			for len(d.Layers) <= MaxLayers {
				d.Layers = append(d.Layers, PaintLayer{ID: newLayerID(), Name: "x", Opacity: 1, Blend: "normal"})
			}
		}, false},
		{"64 layers", func(d *PaintDoc) {
			for len(d.Layers) < MaxLayers {
				d.Layers = append(d.Layers, PaintLayer{ID: newLayerID(), Name: "x", Opacity: 1, Blend: "normal"})
			}
		}, true},
		{"unknown blend", func(d *PaintDoc) { d.Layers[0].Blend = "dissolve" }, false},
		{"every blend", func(d *PaintDoc) {
			for _, b := range Blends {
				d.Layers = append(d.Layers, PaintLayer{ID: newLayerID(), Name: b, Opacity: 0.5, Blend: b})
			}
		}, true},
		{"opacity high", func(d *PaintDoc) { d.Layers[0].Opacity = 1.01 }, false},
		{"opacity negative", func(d *PaintDoc) { d.Layers[0].Opacity = -0.1 }, false},
		{"opacity NaN", func(d *PaintDoc) { d.Layers[0].Opacity = nan() }, false},
		{"duplicate layer id", func(d *PaintDoc) { d.Layers = append(d.Layers, d.Layers[0]) }, false},
		{"unsafe layer id", func(d *PaintDoc) { d.Layers[0].ID = "../x"; d.Active = "../x" }, false},
		{"active missing", func(d *PaintDoc) { d.Active = "nope" }, false},
		{"palette colour", func(d *PaintDoc) { d.Palette = []string{"#00ff00", "zzz"} }, false},
		{"palette too long", func(d *PaintDoc) { d.Palette = slices.Repeat([]string{"#000000"}, MaxPalette+1) }, false},
		{"tile outside", func(d *PaintDoc) { d.Layers[0].Tiles = []string{"5_0"} }, false},
		{"tile key", func(d *PaintDoc) { d.Layers[0].Tiles = []string{"a_b"} }, false},
		{"tile inside", func(d *PaintDoc) { d.Layers[0].Tiles = []string{"0_0"} }, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := good()
			c.mut(&d)
			_, err := validateDoc(d)
			if (err == nil) != c.ok {
				t.Fatalf("ok=%v err=%v", c.ok, err)
			}
			if err != nil {
				var ae *core.AppError
				if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
					t.Fatalf("want a validation error, got %v", err)
				}
			}
		})
	}
}

func nan() float64 { var z float64; return z / z }

// --- projects --------------------------------------------------------------

func TestCreateAndLoad(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	for _, c := range []struct {
		w, h int
		bg   string
		ok   bool
	}{{512, 512, "#ffffff", true}, {8192, 4880, "transparent", true}, {8193, 10, "#ffffff", false}, {8192, 5000, "#ffffff", false}, {0, 5, "#fff", false}, {10, 10, "blue", false}} {
		_, err := e.m.create(ctx, "x", c.w, c.h, c.bg)
		if (err == nil) != c.ok {
			t.Fatalf("%+v: %v", c, err)
		}
	}
	id, err := e.m.create(ctx, "  My   art ", 600, 400, "#102030")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := e.m.load(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Layers) != 1 || doc.Layers[0].Name != "Layer 1" || doc.Active != doc.Layers[0].ID || doc.TileSize != 512 || doc.Source != "" {
		t.Fatalf("doc = %+v", doc)
	}
	list, _ := e.m.docs.List(ctx)
	if p, _ := e.m.docs.Load(ctx, id); len(list) != 3 || p.Name != "My art" {
		t.Fatalf("list = %+v", list)
	}
}

func fileHash(t *testing.T, p string) [32]byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(b)
}

func TestCreateFromImage(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.png")
	img := solid(700, 300, color.NRGBA{200, 50, 20, 255})
	writePNG(t, src, img)
	before := fileHash(t, src)

	id, err := e.m.createFromImage(ctx, src, "", false)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := e.m.load(ctx, id)
	if doc.Width != 700 || doc.Height != 300 || doc.Source != src || len(doc.Layers) != 1 {
		t.Fatalf("doc = %+v", doc)
	}
	if !slices.Equal(doc.Layers[0].Tiles, []string{"0_0", "1_0"}) {
		t.Fatalf("tiles = %v", doc.Layers[0].Tiles)
	}
	list, _ := e.m.docs.List(ctx)
	if list[0].Name != "photo" {
		t.Fatalf("name = %q", list[0].Name)
	}
	// edit and save through every write path; the source stays byte-identical
	doc.Source = "C:/evil.png"
	if err := e.m.saveDoc(ctx, id, "photo", doc); err != nil {
		t.Fatal(err)
	}
	flat, err := e.m.flatten(ctx, id, doc, flattenOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if got := px(flat, 650, 100); got != (color.NRGBA{200, 50, 20, 255}) {
		t.Fatalf("pixel = %v", got)
	}
	again, _ := e.m.load(ctx, id)
	if again.Source != src {
		t.Fatalf("Source was rewritten to %q", again.Source)
	}
	if fileHash(t, src) != before {
		t.Fatal("the source file changed")
	}
}

func TestCreateFromImageLimits(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	src := filepath.Join(t.TempDir(), "wide.png")
	writePNG(t, src, image.NewNRGBA(image.Rect(0, 0, 9000, 40)))
	_, err := e.m.createFromImage(ctx, src, "", false)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeValidation || ae.Hint == "" {
		t.Fatalf("err = %v", err)
	}
	id, err := e.m.createFromImage(ctx, src, "wide", true)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := e.m.load(ctx, id)
	if doc.Width != MaxSide || doc.Height < 1 || doc.Height > 40 {
		t.Fatalf("size = %dx%d", doc.Width, doc.Height)
	}
	if w, h := fitSize(8000, 8000); w*h > MaxPixels || max(w, h) > MaxSide {
		t.Fatalf("fit = %dx%d", w, h)
	}
	if w, h := fitSize(100, 50); w != 100 || h != 50 {
		t.Fatalf("fit = %dx%d", w, h)
	}
	if _, err := e.m.createFromImage(ctx, filepath.Join(t.TempDir(), "nope.png"), "", false); err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

func TestSaveDocGCsRemovedLayers(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "gc", 600, 600, "#ffffff")
	doc, _ := e.m.load(ctx, id)
	second := PaintLayer{ID: newLayerID(), Name: "Two", Opacity: 1, Blend: "normal", Tiles: []string{}}
	doc.Layers = append(doc.Layers, second)
	first, sec := doc.Layers[0], second
	for _, l := range []PaintLayer{first, sec} {
		e.paintLayer(t, id, l.ID, 600, 600, color.NRGBA{1, 2, 3, 255})
	}
	if err := e.m.saveDoc(ctx, id, "gc", doc); err != nil {
		t.Fatal(err)
	}
	doc.Layers = doc.Layers[:1]
	doc.Active = first.ID
	if err := e.m.saveDoc(ctx, id, "gc", doc); err != nil {
		t.Fatal(err)
	}
	base, _ := e.m.layersDir(id)
	if _, err := os.Stat(filepath.Join(base, sec.ID)); !os.IsNotExist(err) {
		t.Fatalf("removed layer's tiles still there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, first.ID, "0_0.png")); err != nil {
		t.Fatalf("kept layer's tiles gone: %v", err)
	}
}

func TestDuplicateRenameImportLayer(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "orig", 600, 300, "#ffffff")
	doc, _ := e.m.load(ctx, id)
	doc.Layers[0].Tiles = e.paintLayer(t, id, doc.Layers[0].ID, 600, 300, color.NRGBA{9, 9, 9, 255})
	if err := e.m.saveDoc(ctx, id, "orig", doc); err != nil {
		t.Fatal(err)
	}
	dup, err := e.m.duplicate(ctx, id)
	if err != nil || dup == id {
		t.Fatalf("dup = %q, %v", dup, err)
	}
	got, err := e.m.tiles(dup, doc.Layers[0].ID, []string{"0_0", "1_0"})
	if err != nil || len(got) != 2 {
		t.Fatalf("duplicate tiles = %d, %v", len(got), err)
	}
	if err := e.m.rename(ctx, dup, "  New name "); err != nil {
		t.Fatal(err)
	}
	p, _ := e.m.docs.Load(ctx, dup)
	if p.Name != "New name" {
		t.Fatalf("name = %q", p.Name)
	}
	if err := e.m.docs.Delete(ctx, dup); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.load(ctx, dup); err == nil {
		t.Fatal("deleted project still loads")
	}

	// import a layer larger than the canvas: scaled down and centred
	src := filepath.Join(t.TempDir(), "sticker.png")
	writePNG(t, src, solid(1200, 300, color.NRGBA{255, 0, 0, 255}))
	l, err := e.m.importLayer(ctx, id, src)
	if err != nil {
		t.Fatal(err)
	}
	if l.Name != "sticker" || len(l.Tiles) == 0 || l.Blend != "normal" || l.Opacity != 1 {
		t.Fatalf("layer = %+v", l)
	}
	doc.Layers = append(doc.Layers, l)
	flat, err := e.m.flatten(ctx, id, doc, flattenOpts{Background: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := px(flat, 300, 150); !near(got, color.NRGBA{255, 0, 0, 255}, 1) {
		t.Fatalf("centre = %v", got)
	}
}

// --- tiles -----------------------------------------------------------------

func tileURL(t *testing.T, w, h int, c color.NRGBA) string {
	return pngDataURL(pngBytes(t, solid(w, h, c)))
}

func TestTilesSaveLoadRemove(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "t", 700, 600, "#ffffff")
	doc, _ := e.m.load(ctx, id)
	lid := doc.Layers[0].ID
	red := color.NRGBA{255, 0, 0, 255}
	err := e.m.saveTiles(id, lid, map[string]string{
		"0_0": tileURL(t, 512, 512, red),
		"1_0": tileURL(t, 188, 512, red), // edge tile, cropped
		"1_1": tileURL(t, 512, 512, red), // full-size edge tile is accepted too
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.m.tiles(id, lid, []string{"0_0", "1_0", "0_1", "1_1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got["0_1"] != "" {
		t.Fatalf("tiles = %v", keys(got))
	}
	if err := e.m.saveTiles(id, lid, map[string]string{"0_0": tileURL(t, 512, 512, color.NRGBA{0, 0, 255, 255})}, []string{"1_0", "0_1"}); err != nil {
		t.Fatal(err)
	}
	got, _ = e.m.tiles(id, lid, []string{"0_0", "1_0"})
	if len(got) != 1 {
		t.Fatalf("after removal: %v", keys(got))
	}
	dir, _ := e.m.layerDir(id, lid)
	img := readPNG(t, filepath.Join(dir, "0_0.png"))
	if px(img, 5, 5) != (color.NRGBA{0, 0, 255, 255}) {
		t.Fatal("tile was not replaced")
	}
	entries, _ := os.ReadDir(dir)
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), ".tmp-") {
			t.Fatalf("temp file left behind: %s", en.Name())
		}
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func TestSaveTilesRefusals(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "t", 700, 600, "#ffffff")
	doc, _ := e.m.load(ctx, id)
	lid := doc.Layers[0].ID
	ok := tileURL(t, 512, 512, color.NRGBA{1, 1, 1, 255})
	big := "data:image/png;base64," + strings.Repeat("A", MaxTileBytes+1)
	notPNG := "data:image/png;base64,AAAA"
	jpegURL := "data:image/jpeg;base64,AAAA"
	cases := []struct {
		name    string
		layer   string
		tiles   map[string]string
		removed []string
	}{
		{"key traversal", lid, map[string]string{"../0_0": ok}, nil},
		{"key format", lid, map[string]string{"a_b": ok}, nil},
		{"outside grid", lid, map[string]string{"2_0": ok}, nil},
		{"outside grid y", lid, map[string]string{"0_2": ok}, nil},
		{"removed outside", lid, nil, []string{"9_9"}},
		{"removed traversal", lid, nil, []string{"..\\..\\x"}},
		{"too large", lid, map[string]string{"0_0": big}, nil},
		{"not png", lid, map[string]string{"0_0": notPNG}, nil},
		{"wrong media type", lid, map[string]string{"0_0": jpegURL}, nil},
		{"wrong size", lid, map[string]string{"0_0": tileURL(t, 100, 100, color.NRGBA{})}, nil},
		{"edge tile wrong size", lid, map[string]string{"1_0": tileURL(t, 200, 512, color.NRGBA{})}, nil},
		{"layer traversal", "../../etc", map[string]string{"0_0": ok}, nil},
		{"layer slash", "a/b", map[string]string{"0_0": ok}, nil},
		{"layer empty", "", map[string]string{"0_0": ok}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := e.m.saveTiles(id, c.layer, c.tiles, c.removed); err == nil {
				t.Fatal("expected a refusal")
			}
		})
	}
	// a refused batch writes nothing, even its valid tiles
	if err := e.m.saveTiles(id, lid, map[string]string{"0_0": ok, "7_7": ok}, nil); err == nil {
		t.Fatal("expected a refusal")
	}
	if got, _ := e.m.tiles(id, lid, []string{"0_0"}); len(got) != 0 {
		t.Fatal("a refused batch was partly written")
	}
	// project IDs can't escape either
	for _, bad := range []string{"..", "../x", "a/b", ""} {
		if err := e.m.saveTiles(bad, lid, map[string]string{"0_0": ok}, nil); err == nil {
			t.Fatalf("project id %q accepted", bad)
		}
		if _, err := e.m.tiles(bad, lid, []string{"0_0"}); err == nil {
			t.Fatalf("tiles: project id %q accepted", bad)
		}
	}
	if _, err := e.m.tiles(id, lid, []string{"../0_0"}); err == nil {
		t.Fatal("tiles accepted a traversal key")
	}
	many := make([]string, MaxTilesPerGet+1)
	for i := range many {
		many[i] = "0_0"
	}
	if _, err := e.m.tiles(id, lid, many); err == nil {
		t.Fatal("tiles accepted too many keys")
	}
}

func TestSaveThumb(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "t", 100, 100, "#ffffff")
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, solid(300, 200, color.NRGBA{9, 9, 9, 255}), nil)
	jurl := "data:image/jpeg;base64," + b64(jb.Bytes())
	purl := pngDataURL(pngBytes(t, solid(900, 600, color.NRGBA{1, 2, 3, 255})))
	if err := e.m.saveThumb(id, jurl, purl); err != nil {
		t.Fatal(err)
	}
	dir, _ := e.m.projectDir(id)
	for _, f := range []string{"thumb.jpg", "render.png"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatal(err)
		}
	}
	list, _ := e.m.docs.List(ctx)
	if list[0].Thumb == "" {
		t.Fatal("the gallery doesn't see the thumbnail")
	}
	jb.Reset()
	_ = jpeg.Encode(&jb, solid(600, 100, color.NRGBA{}), nil)
	if err := e.m.saveThumb(id, "data:image/jpeg;base64,"+b64(jb.Bytes()), ""); err == nil {
		t.Fatal("a 600 px thumbnail was accepted")
	}
	huge := pngDataURL(pngBytes(t, image.NewNRGBA(image.Rect(0, 0, 4100, 4))))
	if err := e.m.saveThumb(id, "", huge); err == nil {
		t.Fatal("a 4100 px render was accepted")
	}
	if err := e.m.saveThumb(id, "data:text/html;base64,AAAA", ""); err == nil {
		t.Fatal("a non-image was accepted")
	}
	if err := e.m.saveThumb("nope", jurl, ""); err == nil {
		t.Fatal("an unknown project was accepted")
	}
}

func b64(b []byte) string { return strings.TrimSpace(pngDataURL(b)[len("data:image/png;base64,"):]) }

// --- compositor ------------------------------------------------------------

func TestFlattenBlendGolden(t *testing.T) {
	back := color.NRGBA{200, 100, 50, 255}
	src := color.NRGBA{128, 64, 255, 255}
	// hand-computed with the W3C formulas on 0..1 channels, rounded.
	cases := []struct {
		mode string
		op   float64
		want color.NRGBA
	}{
		{"normal", 1, color.NRGBA{128, 64, 255, 255}},
		{"normal", 0.5, color.NRGBA{164, 82, 153, 255}},
		{"normal", 0, color.NRGBA{200, 100, 50, 255}},
		// 200*128/255=100.4, 100*64/255=25.1, 50*255/255=50
		{"multiply", 1, color.NRGBA{100, 25, 50, 255}},
		// 200+128-100.4=227.6, 100+64-25.1=138.9, 50+255-50=255
		{"screen", 1, color.NRGBA{228, 139, 255, 255}},
		// overlay = hardlight(cs,cb): cb>.5 -> screen(cs,2cb-1): R cb=.784 s=.5686 -> cs+s-cs*s = .502+.5686-.2855=.7851*? computed below
		{"overlay", 1, color.NRGBA{200, 50, 100, 255}},
		{"add", 1, color.NRGBA{255, 164, 255, 255}},
		{"darken", 1, color.NRGBA{128, 64, 50, 255}},
		{"lighten", 1, color.NRGBA{200, 100, 255, 255}},
	}
	// overlay expectation computed independently per channel
	ov := func(cb, cs float64) float64 {
		cb, cs = cb/255, cs/255
		if cb <= 0.5 {
			return 255 * cs * 2 * cb
		}
		s := 2*cb - 1
		return 255 * (cs + s - cs*s)
	}
	for i := range cases {
		if cases[i].mode == "overlay" {
			cases[i].want = color.NRGBA{uint8(ov(200, 128) + 0.5), uint8(ov(100, 64) + 0.5), uint8(ov(50, 255) + 0.5), 255}
		}
	}
	for _, c := range cases {
		t.Run(c.mode+"/"+ftoa(c.op), func(t *testing.T) {
			e := setup(t)
			ctx := context.Background()
			id, _ := e.m.create(ctx, "b", 4, 4, "#c86432")
			doc, _ := e.m.load(ctx, id)
			l2 := PaintLayer{ID: newLayerID(), Name: "top", Opacity: c.op, Blend: c.mode, Tiles: []string{}}
			doc.Layers = append(doc.Layers, l2)
			doc.Layers[1].Tiles = e.paintLayer(t, id, l2.ID, 4, 4, src)
			flat, err := e.m.flatten(ctx, id, doc, flattenOpts{Background: true})
			if err != nil {
				t.Fatal(err)
			}
			if got := px(flat, 2, 2); !near(got, c.want, 1) {
				t.Fatalf("got %v want %v (backdrop %v)", got, c.want, back)
			}
		})
	}
}

func ftoa(f float64) string { b, _ := json.Marshal(f); return string(b) }

func TestFlattenAlphaHiddenClipAndBackground(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "c", 1024, 512, "transparent")
	doc, _ := e.m.load(ctx, id)
	base := doc.Layers[0]
	// base: opaque red over the left tile only
	baseKeys, _ := writeImageTiles(mustLayerDir(t, e, id, base.ID), solid(512, 512, color.NRGBA{255, 0, 0, 255}), image.Point{}, 1024, 512)
	doc.Layers[0].Tiles = baseKeys
	clipL := PaintLayer{ID: newLayerID(), Name: "clip", Clip: true, Opacity: 1, Blend: "normal", Tiles: []string{}}
	clipL.Tiles = e.paintLayer(t, id, clipL.ID, 1024, 512, color.NRGBA{0, 0, 255, 255})
	hidden := PaintLayer{ID: newLayerID(), Name: "hid", Hidden: true, Opacity: 1, Blend: "normal", Tiles: []string{}}
	hidden.Tiles = e.paintLayer(t, id, hidden.ID, 1024, 512, color.NRGBA{0, 255, 0, 255})
	doc.Layers = append(doc.Layers, clipL, hidden)

	flat, err := e.m.flatten(ctx, id, doc, flattenOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if got := px(flat, 10, 10); got != (color.NRGBA{0, 0, 255, 255}) {
		t.Fatalf("clipped-on-base = %v (blue over red expected)", got)
	}
	if got := px(flat, 900, 10); got.A != 0 {
		t.Fatalf("clip leaked outside its base: %v", got)
	}
	doc.Background = "#ffffff"
	flat, _ = e.m.flatten(ctx, id, doc, flattenOpts{Background: true})
	if got := px(flat, 900, 10); got != (color.NRGBA{255, 255, 255, 255}) {
		t.Fatalf("background = %v", got)
	}
	// a hidden base hides its clip layers
	doc.Layers[0].Hidden = true
	flat, _ = e.m.flatten(ctx, id, doc, flattenOpts{})
	if got := px(flat, 10, 10); got.A != 0 {
		t.Fatalf("clip of a hidden base is visible: %v", got)
	}
	// Only draws one layer regardless of hidden
	flat, _ = e.m.flatten(ctx, id, doc, flattenOpts{Only: hidden.ID})
	if got := px(flat, 10, 10); got != (color.NRGBA{0, 255, 0, 255}) {
		t.Fatalf("only = %v", got)
	}
	// half-transparent source over transparent keeps its colour
	half := PaintLayer{ID: newLayerID(), Name: "half", Opacity: 1, Blend: "multiply", Tiles: []string{}}
	half.Tiles = e.paintLayer(t, id, half.ID, 1024, 512, color.NRGBA{10, 20, 30, 128})
	doc2 := PaintDoc{Width: 1024, Height: 512, Layers: []PaintLayer{half}}
	flat, _ = e.m.flatten(ctx, id, doc2, flattenOpts{})
	if got := px(flat, 3, 3); !near(got, color.NRGBA{10, 20, 30, 128}, 1) {
		t.Fatalf("half alpha = %v", got)
	}
}

func mustLayerDir(t *testing.T, e *env, id, lid string) string {
	t.Helper()
	d, err := e.m.layerDir(id, lid)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// --- ORA -------------------------------------------------------------------

func TestORARoundTrip(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "ora", 600, 300, "#ffffff")
	doc, _ := e.m.load(ctx, id)
	doc.Layers[0].Name = "Back & <white>"
	doc.Layers[0].Tiles = e.paintLayer(t, id, doc.Layers[0].ID, 600, 300, color.NRGBA{10, 200, 30, 255})
	top := PaintLayer{ID: newLayerID(), Name: "Top", Opacity: 0.4, Blend: "multiply", Clip: true, Hidden: true, Tiles: []string{}}
	dir := mustLayerDir(t, e, id, top.ID)
	top.Tiles, _ = writeImageTiles(dir, solid(100, 100, color.NRGBA{255, 0, 0, 200}), image.Pt(550, 250), 600, 300)
	doc.Layers = append(doc.Layers, top)
	if err := e.m.saveDoc(ctx, id, "ora", doc); err != nil {
		t.Fatal(err)
	}
	merged, err := e.m.flatten(ctx, id, doc, flattenOpts{Background: true})
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "x.ora")
	f, _ := os.Create(out)
	layers := make([]oraLayerOut, len(doc.Layers))
	for i, l := range doc.Layers {
		layers[i] = oraLayerOut{layer: l, get: func() (*image.NRGBA, error) { return e.m.layerImage(ctx, id, l, 600, 300) }}
	}
	if err := writeORA(f, 600, 300, layers, merged); err != nil {
		t.Fatal(err)
	}
	f.Close()

	// zip structure: mimetype first, stored
	zb, _ := os.ReadFile(out)
	if !bytes.HasPrefix(zb[30:], []byte("mimetype"+oraMime)) {
		t.Fatalf("mimetype isn't first and stored: %q", zb[30:60])
	}
	id2, err := e.m.importORA(ctx, out)
	if err != nil {
		t.Fatal(err)
	}
	doc2, _ := e.m.load(ctx, id2)
	if doc2.Width != 600 || doc2.Height != 300 || len(doc2.Layers) != 2 || doc2.Source != out {
		t.Fatalf("doc2 = %+v", doc2)
	}
	if doc2.Layers[0].Name != "Back & <white>" || doc2.Layers[1].Name != "Top" {
		t.Fatalf("names = %q %q", doc2.Layers[0].Name, doc2.Layers[1].Name)
	}
	l := doc2.Layers[1]
	if !l.Hidden || !l.Clip || l.Opacity != 0.4 || l.Blend != "multiply" || doc2.Active != l.ID {
		t.Fatalf("layer props = %+v", l)
	}
	for i := range doc.Layers {
		a, _ := e.m.layerImage(ctx, id, doc.Layers[i], 600, 300)
		b, _ := e.m.layerImage(ctx, id2, doc2.Layers[i], 600, 300)
		if !bytes.Equal(a.Pix, b.Pix) {
			t.Fatalf("layer %d pixels differ after the round trip", i)
		}
	}
}

func TestORAReaderRefusals(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	dir := t.TempDir()
	if _, err := e.m.importORA(ctx, filepath.Join(dir, "missing.ora")); err == nil {
		t.Fatal("missing file accepted")
	}
	junk := filepath.Join(dir, "junk.ora")
	_ = os.WriteFile(junk, []byte("not a zip"), 0o644)
	if _, err := e.m.importORA(ctx, junk); err == nil {
		t.Fatal("junk accepted")
	}
	// a stack that points a layer outside the archive
	evil := filepath.Join(dir, "evil.ora")
	writeZip(t, evil, map[string]string{
		"mimetype":  oraMime,
		"stack.xml": `<image w="10" h="10"><stack><layer name="a" src="../../etc/passwd" x="0" y="0"/></stack></image>`,
	})
	if _, err := e.m.importORA(ctx, evil); err == nil {
		t.Fatal("unsafe layer path accepted")
	}
	huge := filepath.Join(dir, "huge.ora")
	writeZip(t, huge, map[string]string{"stack.xml": `<image w="9000" h="10"><stack><layer src="data/a.png"/></stack></image>`})
	if _, err := e.m.importORA(ctx, huge); err == nil {
		t.Fatal("oversized canvas accepted")
	}
	if list, _ := e.m.docs.List(ctx); len(list) != 0 {
		t.Fatalf("failed imports left %d projects", len(list))
	}
}

// --- export ----------------------------------------------------------------

type recorder struct {
	mu      sync.Mutex
	outputs []string
	lineage map[string][]string
	title   string
	prog    []float64
}

func (r *recorder) hooks(tool func(string) (string, error)) core.JobHooks {
	r.lineage = map[string][]string{}
	return core.JobHooks{
		Output: func(p string) (core.Output, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.outputs = append(r.outputs, p)
			r.lineage[p] = nil
			return core.Output{Path: p}, nil
		},
		OutputFrom: func(p string, in []string) (core.Output, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.outputs = append(r.outputs, p)
			r.lineage[p] = in
			return core.Output{Path: p}, nil
		},
		Title:    func(s string) { r.title = s },
		Progress: func(p float64, _ string) { r.prog = append(r.prog, p) },
		Tool:     tool,
	}
}

func noTool(id string) (string, error) { return "", core.ErrDependencyMissing(id, "no") }

func (e *env) runExport(t *testing.T, rec *recorder, opts ExportOptions) error {
	t.Helper()
	raw, _ := json.Marshal(opts)
	if err := e.m.Validate(nil, raw); err != nil {
		return err
	}
	out := filepath.Join(e.library, "Paintings")
	_ = os.MkdirAll(out, 0o755)
	job := core.NewJobContext(core.JobContext{ID: "j", Options: raw, OutputDir: out, TempDir: t.TempDir()}, rec.hooks(noTool))
	return e.m.Run(context.Background(), job)
}

func (e *env) simpleProject(t *testing.T, name string, w, h int, bg string, c color.NRGBA) string {
	t.Helper()
	ctx := context.Background()
	id, err := e.m.create(ctx, name, w, h, bg)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := e.m.load(ctx, id)
	doc.Layers[0].Tiles = e.paintLayer(t, id, doc.Layers[0].ID, w, h, c)
	if err := e.m.saveDoc(ctx, id, name, doc); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestExportNamingAndNoOverwrite(t *testing.T) {
	e := setup(t)
	id := e.simpleProject(t, "My: Art?", 60, 40, "#ffffff", color.NRGBA{255, 0, 0, 255})
	opts := DefaultExportOptions()
	opts.ProjectID = id
	var paths []string
	for i := 0; i < 3; i++ {
		rec := &recorder{}
		if err := e.runExport(t, rec, opts); err != nil {
			t.Fatal(err)
		}
		if len(rec.outputs) != 1 {
			t.Fatalf("outputs = %v", rec.outputs)
		}
		paths = append(paths, rec.outputs[0])
	}
	want := []string{"My Art.png", "My Art (1).png", "My Art (2).png"}
	for i, p := range paths {
		if filepath.Base(p) != want[i] || filepath.Base(filepath.Dir(p)) != "Paintings" {
			t.Fatalf("paths = %v", paths)
		}
	}
	// pre-existing files are never touched
	keep := filepath.Join(e.library, "Paintings", "Keep.png")
	_ = os.WriteFile(keep, []byte("mine"), 0o644)
	opts.Name = "Keep"
	rec := &recorder{}
	if err := e.runExport(t, rec, opts); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(keep); string(b) != "mine" {
		t.Fatal("an existing file was overwritten")
	}
	if filepath.Base(rec.outputs[0]) != "Keep (1).png" {
		t.Fatalf("out = %v", rec.outputs)
	}
	img := readPNG(t, paths[0])
	if img.Bounds().Dx() != 60 || px(img, 5, 5) != (color.NRGBA{255, 0, 0, 255}) {
		t.Fatalf("png = %v %v", img.Bounds(), px(img, 5, 5))
	}
}

func TestCleanFileName(t *testing.T) {
	for in, want := range map[string]string{
		"": "Painting", "  ": "Painting", "a/b\\c": "a b c", "con": "_con", "x.": "x", "..": "Painting",
		"ok name": "ok name", strings.Repeat("a", 300): strings.Repeat("a", 120),
	} {
		if got := cleanFileName(in); got != want {
			t.Errorf("cleanFileName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExportFormatsScaleAndSource(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "photo.png")
	writePNG(t, src, solid(300, 200, color.NRGBA{10, 120, 240, 255}))
	before := fileHash(t, src)
	id, err := e.m.createFromImage(ctx, src, "from photo", false)
	if err != nil {
		t.Fatal(err)
	}
	opts := DefaultExportOptions()
	opts.ProjectID = id
	opts.Scale = 2
	rec := &recorder{}
	if err := e.runExport(t, rec, opts); err != nil {
		t.Fatal(err)
	}
	p := rec.outputs[0]
	if got := rec.lineage[p]; len(got) != 1 || got[0] != src {
		t.Fatalf("lineage = %v", got)
	}
	img := readPNG(t, p)
	if img.Bounds().Dx() != 600 || img.Bounds().Dy() != 400 || !near(px(img, 300, 200), color.NRGBA{10, 120, 240, 255}, 1) {
		t.Fatalf("scaled png = %v %v", img.Bounds(), px(img, 300, 200))
	}
	// JPG refuses a transparent canvas (this project has none), PNG keeps alpha
	opts.Format, opts.Quality, opts.Scale = FormatJPG, 90, 0.5
	if err := e.runExport(t, &recorder{}, opts); err == nil {
		t.Fatal("transparent JPG accepted")
	}
	// blank (no Source) project: Output without lineage; JPG + ORA
	bgid := e.simpleProject(t, "blank", 80, 60, "#336699", color.NRGBA{255, 255, 255, 0})
	opts.ProjectID = bgid
	rec = &recorder{}
	if err := e.runExport(t, rec, opts); err != nil {
		t.Fatal(err)
	}
	jp := rec.outputs[0]
	if rec.lineage[jp] != nil || filepath.Ext(jp) != ".jpg" {
		t.Fatalf("jpg export = %v %v", jp, rec.lineage[jp])
	}
	f, _ := os.Open(jp)
	jimg, err := jpeg.Decode(f)
	f.Close()
	if err != nil || jimg.Bounds().Dx() != 40 {
		t.Fatalf("jpg = %v %v", err, jimg)
	}
	opts.Format, opts.Scale = FormatORA, 1
	rec = &recorder{}
	if err := e.runExport(t, rec, opts); err != nil {
		t.Fatal(err)
	}
	o, err := openORA(rec.outputs[0])
	if err != nil {
		t.Fatal(err)
	}
	if o.W != 80 || o.H != 60 || len(o.Layers) != 1 {
		t.Fatalf("ora = %+v", o)
	}
	o.Close()
	// WebP needs FFmpeg: missing tool fails cleanly with a dependency error
	opts.Format = FormatWebP
	err = e.runExport(t, &recorder{}, opts)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("webp without ffmpeg: %v", err)
	}
	if fileHash(t, src) != before {
		t.Fatal("the source file changed")
	}
}

func TestExportValidation(t *testing.T) {
	e := setup(t)
	id := e.simpleProject(t, "v", 60, 40, "#ffffff", color.NRGBA{1, 2, 3, 255})
	ok := func() ExportOptions { o := DefaultExportOptions(); o.ProjectID = id; return o }
	cases := []struct {
		name string
		mut  func(o *ExportOptions)
		bad  bool
	}{
		{"ok", func(o *ExportOptions) {}, false},
		{"format", func(o *ExportOptions) { o.Format = "gif" }, true},
		{"scale low", func(o *ExportOptions) { o.Scale = 0.2 }, true},
		{"scale high", func(o *ExportOptions) { o.Scale = 4.1 }, true},
		{"scale edges", func(o *ExportOptions) { o.Scale = 0.25 }, false},
		{"jpg quality", func(o *ExportOptions) { o.Format = FormatJPG; o.Quality = 50 }, true},
		{"webp quality ok", func(o *ExportOptions) { o.Format = FormatWebP; o.Quality = 100 }, false},
		{"unknown project", func(o *ExportOptions) { o.ProjectID = "nope" }, true},
		{"traversal project", func(o *ExportOptions) { o.ProjectID = "../x" }, true},
		{"flattened junk", func(o *ExportOptions) { o.Flattened = "http://x" }, true},
		{"flattened file outside tmp", func(o *ExportOptions) { o.Flattened = "file:" + filepath.Join(e.support, "toolbox.db") }, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := ok()
			c.mut(&o)
			raw, _ := json.Marshal(o)
			err := e.m.Validate(nil, raw)
			if (err != nil) != c.bad {
				t.Fatalf("err = %v", err)
			}
		})
	}
	raw, _ := json.Marshal(ok())
	if err := e.m.Validate([]string{"x.png"}, raw); err == nil {
		t.Fatal("export with inputs accepted")
	}
	if err := e.m.Validate(nil, json.RawMessage(`{"projectId":"`+id+`","format":"png","scale":1,"extra":1}`)); err == nil {
		t.Fatal("unknown field accepted")
	}
}

func TestExportNeedsFlattenedForOtherBlends(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id := e.simpleProject(t, "soft", 40, 40, "#ffffff", color.NRGBA{1, 2, 3, 255})
	doc, _ := e.m.load(ctx, id)
	doc.Layers[0].Blend = "soft-light"
	if err := e.m.saveDoc(ctx, id, "soft", doc); err != nil {
		t.Fatal(err)
	}
	opts := DefaultExportOptions()
	opts.ProjectID = id
	if err := e.runExport(t, &recorder{}, opts); err == nil {
		t.Fatal("export with a non-Go blend and no render accepted")
	}
	opts.Flattened = pngDataURL(pngBytes(t, solid(40, 40, color.NRGBA{77, 88, 99, 255})))
	rec := &recorder{}
	if err := e.runExport(t, rec, opts); err != nil {
		t.Fatal(err)
	}
	if got := px(readPNG(t, rec.outputs[0]), 5, 5); got != (color.NRGBA{77, 88, 99, 255}) {
		t.Fatalf("flattened not used: %v", got)
	}
	// a hidden soft-light layer doesn't require it
	doc.Layers[0].Hidden = true
	_ = e.m.saveDoc(ctx, id, "soft", doc)
	opts.Flattened = ""
	if err := e.runExport(t, &recorder{}, opts); err != nil {
		t.Fatalf("hidden layer needs no render: %v", err)
	}
	// ORA keeps layers and needs no render
	doc.Layers[0].Hidden = false
	_ = e.m.saveDoc(ctx, id, "soft", doc)
	opts.Format = FormatORA
	if err := e.runExport(t, &recorder{}, opts); err != nil {
		t.Fatalf("ora: %v", err)
	}
}

func TestExportAs(t *testing.T) {
	e := setup(t)
	id := e.simpleProject(t, "as", 30, 30, "#ffffff", color.NRGBA{5, 6, 7, 255})
	dest := filepath.Join(t.TempDir(), "chosen")
	var gotName string
	e.m.cfg.SaveDialog = func(title, name string) (string, error) { gotName = name; return dest, nil }
	opts := DefaultExportOptions()
	opts.ProjectID = id
	p, err := e.m.exportAs(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if gotName != "as.png" || p != dest+".png" {
		t.Fatalf("name %q path %q", gotName, p)
	}
	if got := px(readPNG(t, p), 1, 1); got != (color.NRGBA{5, 6, 7, 255}) {
		t.Fatalf("pixel = %v", got)
	}
	e.m.cfg.SaveDialog = func(string, string) (string, error) { return "", nil }
	if p, err := e.m.exportAs(context.Background(), opts); p != "" || err != nil {
		t.Fatalf("cancel = %q %v", p, err)
	}
}

// --- pipeline step ---------------------------------------------------------

func TestDecodeStepAndValidate(t *testing.T) {
	e := setup(t)
	id := e.simpleProject(t, "s", 10, 10, "#ffffff", color.NRGBA{1, 1, 1, 255})
	in := filepath.Join(t.TempDir(), "a.png")
	writePNG(t, in, solid(20, 10, color.NRGBA{9, 9, 9, 255}))
	good := func(o StepOptions) json.RawMessage { b, _ := json.Marshal(o); return b }
	ov := DefaultStepOptions()
	ov.Project = id
	if err := e.m.Validate([]string{in}, good(ov)); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Validate(nil, good(ov)); err == nil {
		t.Fatal("step without inputs accepted")
	}
	if err := e.m.Validate([]string{filepath.Join(t.TempDir(), "x.png")}, good(ov)); err == nil {
		t.Fatal("missing input accepted")
	}
	if err := e.m.Validate([]string{in}, json.RawMessage(`{"action":"overlay","project":"`+id+`","fit":"contain","bogus":1}`)); err == nil {
		t.Fatal("unknown field accepted")
	}
	bad := ov
	bad.Project = "gone"
	if err := e.m.Validate([]string{in}, good(bad)); err == nil {
		t.Fatal("missing project accepted")
	}
	dis := DefaultStepOptions()
	dis.Action, dis.Project = StepDissolve, id
	if err := e.m.Validate([]string{in}, good(dis)); err == nil {
		t.Fatal("dissolve without layer or mask accepted")
	}
	dis.Layer = "nolayer"
	if err := e.m.Validate([]string{in}, good(dis)); err == nil {
		t.Fatal("dissolve with a missing layer accepted")
	}
}

func TestPrepareStepOneJobPerPicture(t *testing.T) {
	e := setup(t)
	id := e.simpleProject(t, "s", 10, 10, "#ffffff", color.NRGBA{1, 1, 1, 255})
	o := DefaultStepOptions()
	o.Project = id
	raw, _ := json.Marshal(o)
	req := core.StepRequest{Options: raw, Item: core.StepItem{Files: []core.RunFile{{Path: "/a.png"}, {Path: "/b.png"}}}}
	jobs, err := e.m.PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 2 || jobs[1].Inputs[0] != "/b.png" {
		t.Fatalf("jobs = %+v, %v", jobs, err)
	}
	if got := jobs[0].Options.(StepOptions); got.Action != StepOverlay || got.Project != id {
		t.Fatalf("options = %+v", got)
	}
	o.Project = "gone"
	raw, _ = json.Marshal(o)
	req.Options = raw
	if _, err := e.m.PrepareStep(context.Background(), req); err == nil {
		t.Fatal("missing project accepted")
	}
	// dissolve resolves its mask when preparing
	d := DefaultStepOptions()
	d.Action, d.Mask = StepDissolve, "abc"
	raw, _ = json.Marshal(d)
	req.Options = raw
	e.m.cfg.SavedMask = func(id string) (string, error) { return "", core.Errorf(core.CodeNotFound, "That mask doesn't exist") }
	if _, err := e.m.PrepareStep(context.Background(), req); err == nil {
		t.Fatal("missing mask accepted")
	}
}

func TestOverlayJobEndToEnd(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	// the painting: 100x100 transparent canvas with a red 50x50 square top-left
	id, _ := e.m.create(ctx, "mark", 100, 100, "#00ff00") // background must NOT be drawn
	doc, _ := e.m.load(ctx, id)
	dir := mustLayerDir(t, e, id, doc.Layers[0].ID)
	doc.Layers[0].Tiles, _ = writeImageTiles(dir, solid(50, 50, color.NRGBA{255, 0, 0, 255}), image.Point{}, 100, 100)
	_ = e.m.saveDoc(ctx, id, "mark", doc)

	inDir := t.TempDir()
	in := filepath.Join(inDir, "pic.png")
	writePNG(t, in, solid(400, 200, color.NRGBA{0, 0, 255, 255}))
	before := fileHash(t, in)

	run := func(fit string) (*image.NRGBA, string, *recorder) {
		o := DefaultStepOptions()
		o.Project, o.Fit = id, fit
		raw, _ := json.Marshal(o)
		if err := e.m.Validate([]string{in}, raw); err != nil {
			t.Fatal(err)
		}
		rec := &recorder{}
		out := filepath.Join(e.library, "Paintings")
		_ = os.MkdirAll(out, 0o755)
		job := core.NewJobContext(core.JobContext{ID: "j", Inputs: []string{in}, Options: raw, OutputDir: out, TempDir: t.TempDir()}, rec.hooks(noTool))
		if err := e.m.Run(ctx, job); err != nil {
			t.Fatal(err)
		}
		if len(rec.outputs) != 1 {
			t.Fatalf("outputs = %v", rec.outputs)
		}
		return readPNG(t, rec.outputs[0]), rec.outputs[0], rec
	}
	// contain: art is 200x200, centred at x 100..300; its red square is x 100..200, y 0..100
	img, p, rec := run("contain")
	if img.Bounds().Dx() != 400 || img.Bounds().Dy() != 200 {
		t.Fatalf("size = %v", img.Bounds())
	}
	if got := px(img, 150, 50); !near(got, color.NRGBA{255, 0, 0, 255}, 1) {
		t.Fatalf("red square = %v", got)
	}
	if got := px(img, 250, 150); !near(got, color.NRGBA{0, 0, 255, 255}, 1) {
		t.Fatalf("transparent art area must show the picture, got %v", got)
	}
	if got := px(img, 20, 20); !near(got, color.NRGBA{0, 0, 255, 255}, 1) {
		t.Fatalf("outside the art = %v", got)
	}
	if lin := rec.lineage[p]; len(lin) != 1 || lin[0] != in {
		t.Fatalf("lineage = %v", lin)
	}
	if filepath.Base(p) != "pic painted.png" {
		t.Fatalf("name = %s", filepath.Base(p))
	}
	// stretch: art covers the whole picture, red square = 200x100 top-left
	img, _, _ = run("stretch")
	if got := px(img, 150, 50); !near(got, color.NRGBA{255, 0, 0, 255}, 1) {
		t.Fatalf("stretch red = %v", got)
	}
	if got := px(img, 300, 150); !near(got, color.NRGBA{0, 0, 255, 255}, 1) {
		t.Fatalf("stretch blue = %v", got)
	}
	// cover: art 400x400 centred (y -100..300): red square x0..200, y-100..100
	img, _, _ = run("cover")
	if got := px(img, 100, 50); !near(got, color.NRGBA{255, 0, 0, 255}, 1) {
		t.Fatalf("cover red = %v", got)
	}
	if got := px(img, 100, 150); !near(got, color.NRGBA{0, 0, 255, 255}, 1) {
		t.Fatalf("cover blue = %v", got)
	}
	if fileHash(t, in) != before {
		t.Fatal("the input was modified")
	}
}

type fakeCaller struct {
	method string
	params map[string]any
	err    error
	srcW   int
	maskP  []byte
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.method = method
	f.params, _ = params.(map[string]any)
	if f.err != nil {
		return nil, f.err
	}
	onEvent(sidecar.Event{Kind: "progress", Pct: 0.5, Msg: "pass 1"})
	src, _ := os.ReadFile(f.params["src"].(string))
	img, _ := png.Decode(bytes.NewReader(src))
	f.srcW = img.Bounds().Dx()
	f.maskP, _ = os.ReadFile(f.params["mask"].(string))
	out := solid(img.Bounds().Dx(), img.Bounds().Dy(), color.NRGBA{1, 2, 3, 255})
	if err := os.WriteFile(f.params["out"].(string), pngBytes2(out), 0o644); err != nil {
		return nil, err
	}
	return json.RawMessage(`{"output":"` + strings.ReplaceAll(f.params["out"].(string), `\`, `\\`) + `","passes":6}`), nil
}

func pngBytes2(img image.Image) []byte { b, _ := encodePNG(img); return b }

type fakeModels struct{ ok bool }

func (f fakeModels) Inpaint(model string) (json.RawMessage, bool) {
	return json.RawMessage(`"C:/models/` + model + `.onnx"`), f.ok
}
func (fakeModels) Cutout(string) (json.RawMessage, bool)  { return nil, false }
func (fakeModels) Segment() (json.RawMessage, bool)       { return nil, false }
func (fakeModels) Enhance(string) (json.RawMessage, bool) { return nil, false }

func TestDissolveJobParamsAndMasks(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	// project 100x50 with a mask layer: alpha>0 on the left 50x50
	id, _ := e.m.create(ctx, "mask", 100, 50, "#ffffff")
	doc, _ := e.m.load(ctx, id)
	maskLayer := PaintLayer{ID: newLayerID(), Name: "mask", Opacity: 1, Blend: "normal", Tiles: []string{}}
	maskLayer.Tiles, _ = writeImageTiles(mustLayerDir(t, e, id, maskLayer.ID), solid(50, 50, color.NRGBA{0, 0, 0, 3}), image.Point{}, 100, 50)
	doc.Layers = append(doc.Layers, maskLayer)
	if err := e.m.saveDoc(ctx, id, "mask", doc); err != nil {
		t.Fatal(err)
	}
	in := filepath.Join(t.TempDir(), "photo.png")
	writePNG(t, in, solid(200, 100, color.NRGBA{50, 60, 70, 255}))
	before := fileHash(t, in)

	fc := &fakeCaller{}
	e.m.cfg.Engine = fc
	e.m.cfg.Models = fakeModels{ok: true}
	o := DefaultStepOptions()
	o.Action, o.Project, o.Layer = StepDissolve, id, maskLayer.ID
	o.Passes, o.Ghost, o.Drift, o.Seed, o.Model = 4, 0.25, 0.75, 42, "best"
	raw, _ := json.Marshal(o)
	if err := e.m.Validate([]string{in}, raw); err != nil {
		t.Fatal(err)
	}
	rec := &recorder{}
	out := filepath.Join(e.library, "Paintings")
	_ = os.MkdirAll(out, 0o755)
	tool := func(id string) (string, error) { return "/engine", nil }
	job := core.NewJobContext(core.JobContext{ID: "j", Inputs: []string{in}, Options: raw, OutputDir: out, TempDir: t.TempDir()}, rec.hooks(tool))
	if err := e.m.Run(ctx, job); err != nil {
		t.Fatal(err)
	}
	if fc.method != "paint.fill" {
		t.Fatalf("method = %q", fc.method)
	}
	p := fc.params
	if p["model"] != "best" || p["modelPath"] != "C:/models/best.onnx" || p["passes"] != 4 || p["ghost"] != 0.25 || p["drift"] != 0.75 || p["seed"] != int64(42) {
		t.Fatalf("params = %v", p)
	}
	if fc.srcW != 200 {
		t.Fatalf("source width = %d", fc.srcW)
	}
	mask, _ := png.Decode(bytes.NewReader(fc.maskP))
	if mask.Bounds().Dx() != 200 || mask.Bounds().Dy() != 100 {
		t.Fatalf("mask size = %v (must match the photo)", mask.Bounds())
	}
	white := func(x, y int) bool { r, _, _, _ := mask.At(x, y).RGBA(); return r > 0x8000 }
	if !white(40, 50) || white(150, 50) {
		t.Fatal("mask doesn't follow the layer's alpha (stretched to the photo)")
	}
	if len(rec.outputs) != 1 || filepath.Base(rec.outputs[0]) != "photo dissolved.png" || len(rec.lineage[rec.outputs[0]]) != 1 {
		t.Fatalf("outputs = %v %v", rec.outputs, rec.lineage)
	}
	if got := px(readPNG(t, rec.outputs[0]), 3, 3); got != (color.NRGBA{1, 2, 3, 255}) {
		t.Fatalf("result = %v", got)
	}

	// saved Object Eraser mask: white = dissolve (scaled to the photo)
	mp := filepath.Join(t.TempDir(), "m.png")
	mi := image.NewNRGBA(image.Rect(0, 0, 20, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 10; x++ {
			mi.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
		}
	}
	writePNG(t, mp, mi)
	e.m.cfg.SavedMask = func(id string) (string, error) {
		if id != "m1" {
			return "", core.Errorf(core.CodeNotFound, "That mask doesn't exist")
		}
		return mp, nil
	}
	o2 := DefaultStepOptions()
	o2.Action, o2.Mask = StepDissolve, "m1"
	raw, _ = json.Marshal(o2)
	job = core.NewJobContext(core.JobContext{ID: "j2", Inputs: []string{in}, Options: raw, OutputDir: out, TempDir: t.TempDir()}, (&recorder{}).hooks(tool))
	if err := e.m.Run(ctx, job); err != nil {
		t.Fatal(err)
	}
	mask, _ = png.Decode(bytes.NewReader(fc.maskP))
	if fc.params["model"] != "fast" || mask.Bounds().Dx() != 200 || !white(10, 10) || white(150, 50) {
		t.Fatalf("eraser mask params = %v", fc.params)
	}
	if fileHash(t, in) != before {
		t.Fatal("the input was modified")
	}
}

func TestDissolveFailures(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	id, _ := e.m.create(ctx, "mask", 100, 50, "#ffffff")
	doc, _ := e.m.load(ctx, id)
	in := filepath.Join(t.TempDir(), "photo.png")
	writePNG(t, in, solid(20, 10, color.NRGBA{50, 60, 70, 255}))
	o := DefaultStepOptions()
	o.Action, o.Project, o.Layer = StepDissolve, id, doc.Layers[0].ID // empty layer = empty mask
	raw, _ := json.Marshal(o)
	tool := func(string) (string, error) { return "/engine", nil }
	run := func() error {
		job := core.NewJobContext(core.JobContext{ID: "j", Inputs: []string{in}, Options: raw, OutputDir: t.TempDir(), TempDir: t.TempDir()}, (&recorder{}).hooks(tool))
		return e.m.Run(ctx, job)
	}
	var ae *core.AppError
	if err := run(); !errors.As(err, &ae) {
		t.Fatalf("no engine: %v", err)
	}
	e.m.cfg.Engine = &fakeCaller{}
	if err := run(); !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("nil models: %v", err)
	}
	e.m.cfg.Models = fakeModels{ok: false}
	if err := run(); !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("model not installed: %v", err)
	}
	e.m.cfg.Models = fakeModels{ok: true}
	if err := run(); !errors.As(err, &ae) || ae.Code != core.CodeValidation || !strings.Contains(ae.Message, "empty") {
		t.Fatalf("empty mask: %v", err)
	}
	// engine errors surface
	doc.Layers[0].Tiles = e.paintLayer(t, id, doc.Layers[0].ID, 100, 50, color.NRGBA{0, 0, 0, 255})
	_ = e.m.saveDoc(ctx, id, "mask", doc)
	e.m.cfg.Engine = &fakeCaller{err: errors.New("boom")}
	if err := run(); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("engine error: %v", err)
	}
	// no engine tool installed
	noEngine := func(string) (string, error) { return "", core.ErrDependencyMissing("audio-engine", "install") }
	e.m.cfg.Engine = &fakeCaller{}
	job := core.NewJobContext(core.JobContext{ID: "j", Inputs: []string{in}, Options: raw, OutputDir: t.TempDir(), TempDir: t.TempDir()}, (&recorder{}).hooks(noEngine))
	if err := e.m.Run(ctx, job); !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("engine missing: %v", err)
	}
}
