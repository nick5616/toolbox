package composer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/core/store"
	"toolbox/modules/bgremove"
)

// --- fakes -----------------------------------------------------------------

type fakeEngine struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (f *fakeEngine) Call(_ context.Context, method string, params any, _ func(sidecar.Event)) (json.RawMessage, error) {
	f.mu.Lock()
	f.calls = append(f.calls, method)
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	if method == "image.convert" {
		out := params.(map[string]any)["output"].(string)
		img := image.NewNRGBA(image.Rect(0, 0, 40, 20))
		for i := 0; i < len(img.Pix); i += 4 {
			img.Pix[i], img.Pix[i+3] = 200, 255
		}
		var buf bytes.Buffer
		_ = png.Encode(&buf, img)
		if err := os.WriteFile(out, buf.Bytes(), 0o644); err != nil {
			return nil, err
		}
	}
	return json.RawMessage(`{}`), nil
}

func (f *fakeEngine) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type recEmitter struct {
	mu     sync.Mutex
	events []string
}

func (r *recEmitter) Emit(name string, _ any) {
	r.mu.Lock()
	r.events = append(r.events, name)
	r.mu.Unlock()
}

type fakeBG struct {
	mu   sync.Mutex
	opts string
}

func (f *fakeBG) Descriptor() core.Descriptor {
	return core.Descriptor{ID: bgremove.ModuleID, Name: "BG", Status: core.StatusReady, OutputSubdir: "bg"}
}

func (f *fakeBG) Validate(_ []string, o json.RawMessage) error {
	f.mu.Lock()
	f.opts = string(o)
	f.mu.Unlock()
	return nil
}

func (f *fakeBG) Run(context.Context, *core.JobContext) error { return nil }

type env struct {
	m       *Module
	svc     *Service
	db      *store.DB
	eng     *fakeEngine
	em      *recEmitter
	bg      *fakeBG
	lib     string
	support string
}

func setup(t *testing.T) *env {
	t.Helper()
	support := t.TempDir()
	db, err := store.Open(filepath.Join(support, "toolbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	e := &env{db: db, eng: &fakeEngine{}, em: &recEmitter{}, bg: &fakeBG{}, lib: t.TempDir(), support: support}
	reg := core.NewRegistry()
	if err := reg.Register(e.bg); err != nil {
		t.Fatal(err)
	}
	jobs := core.NewJobs(db, db, reg, e.em, func(id string) (string, error) { return "/bin/" + id, nil },
		func() core.Settings { return core.Settings{LibraryDir: e.lib, Concurrency: 1} }, filepath.Join(support, "tmp"))
	t.Cleanup(func() { _ = jobs.Shutdown(5 * time.Second) })
	e.m = New(Config{
		Store: db, ProjectsDir: filepath.Join(support, "projects"), CacheDir: filepath.Join(support, "cache", "composer"),
		Engine: e.eng, Jobs: jobs, Outputs: db, Emitter: e.em, LibraryDir: func() string { return e.lib },
	})
	e.svc = NewService(e.m)
	return e
}

func newDoc(t *testing.T) Composition {
	t.Helper()
	d, err := NewComposition("4:5", "")
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func textLayer(id string) Layer {
	return Layer{ID: id, Kind: "text", Name: "T", X: 0.5, Y: 0.5, Size: 0.08, Opacity: 1,
		Text:   &TextLayer{Text: "hi", Font: "Arial", Color: "#000000", Align: "center", LineHeight: 1.2},
		Look:   Look{Preset: "none"},
		Shadow: Shadow{Color: "#000000", Opacity: 0.4}, Outline: Outline{Color: "#ffffff"}}
}

func imageLayer(id, path string) Layer {
	return Layer{ID: id, Kind: "image", Name: "P", X: 0.5, Y: 0.5, Size: 0.5, Opacity: 1,
		Image:  &ImageLayer{Ref: ImageRef{Path: path}, Crop: Rect{0, 0, 1, 1}},
		Look:   Look{Preset: "none"},
		Shadow: Shadow{Color: "#000000", Opacity: 0.4}, Outline: Outline{Color: "#ffffff"}}
}

// --- tests -----------------------------------------------------------------

func TestCreate(t *testing.T) {
	e := setup(t)
	for _, a := range Aspects() {
		info, err := e.svc.Create("Shirts", a.ID, "")
		if err != nil {
			t.Fatalf("%s: %v", a.ID, err)
		}
		doc, err := e.svc.Get(info.ID)
		if err != nil {
			t.Fatal(err)
		}
		if doc.Width != a.Width || doc.Height != a.Height || doc.Version != 1 || doc.Format != "jpg" || doc.Background.Kind != "color" || doc.Background.Color != "#ffffff" {
			t.Errorf("%s: %+v", a.ID, doc)
		}
		if err := Validate(doc); err != nil {
			t.Errorf("%s: fresh document invalid: %v", a.ID, err)
		}
	}
	if _, err := e.svc.Create("x", "7:3", ""); err == nil {
		t.Error("unknown aspect accepted")
	}
	bgp := filepath.Join(t.TempDir(), "bg.jpg")
	info, err := e.svc.Create("", "1:1", bgp)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := e.svc.Get(info.ID)
	if doc.Background.Kind != "image" || doc.Background.Image == nil || doc.Background.Image.Path != bgp || info.Name != "Untitled" {
		t.Errorf("background: %+v name %q", doc.Background, info.Name)
	}
	if _, err := e.svc.Create("x", "1:1", "relative.jpg"); err == nil {
		t.Error("relative background path accepted")
	}
}

func TestValidate(t *testing.T) {
	long := strings.Repeat("a", MaxTextChars+1)
	many := func() []Layer {
		var ls []Layer
		for i := 0; i <= MaxLayers; i++ {
			ls = append(ls, textLayer(string(rune('a'+i%26))+strings.Repeat("x", i)))
		}
		return ls
	}
	cases := []struct {
		name string
		mod  func(d *Composition)
		bad  bool
	}{
		{"fresh", func(d *Composition) {}, false},
		{"two layers", func(d *Composition) { d.Layers = []Layer{textLayer("a"), imageLayer("b", "/x.png")} }, false},
		{"version", func(d *Composition) { d.Version = 2 }, true},
		{"aspect unknown", func(d *Composition) { d.Aspect = "2:1" }, true},
		{"size mismatch", func(d *Composition) { d.Height = 1000 }, true},
		{"format", func(d *Composition) { d.Format = "gif" }, true},
		{"png ok", func(d *Composition) { d.Format = "png" }, false},
		{"bg kind", func(d *Composition) { d.Background.Kind = "video" }, true},
		{"bg colour", func(d *Composition) { d.Background.Color = "white" }, true},
		{"gradient needs colour2", func(d *Composition) { d.Background.Kind = "gradient"; d.Background.Color2 = "" }, true},
		{"gradient ok", func(d *Composition) { d.Background.Kind = "gradient" }, false},
		{"bg image missing", func(d *Composition) { d.Background.Kind = "image" }, true},
		{"zoom low", func(d *Composition) { d.Background.Zoom = 0.5 }, true},
		{"zoom high", func(d *Composition) { d.Background.Zoom = 4.5 }, true},
		{"pan", func(d *Composition) { d.Background.PanX = 1.5 }, true},
		{"blur", func(d *Composition) { d.Background.Blur = 2 }, true},
		{"look preset", func(d *Composition) { d.Background.Look.Preset = "sepia" }, true},
		{"look value", func(d *Composition) { d.Background.Look.Warmth = -2 }, true},
		{"too many layers", func(d *Composition) { d.Layers = many() }, true},
		{"duplicate ids", func(d *Composition) { d.Layers = []Layer{textLayer("a"), textLayer("a")} }, true},
		{"empty id", func(d *Composition) { d.Layers = []Layer{textLayer("")} }, true},
		{"layer kind", func(d *Composition) { l := textLayer("a"); l.Kind = "shape"; d.Layers = []Layer{l} }, true},
		{"opacity", func(d *Composition) { l := textLayer("a"); l.Opacity = 1.5; d.Layers = []Layer{l} }, true},
		{"size zero", func(d *Composition) { l := textLayer("a"); l.Size = 0; d.Layers = []Layer{l} }, true},
		{"nan", func(d *Composition) { l := textLayer("a"); l.X = nan(); d.Layers = []Layer{l} }, true},
		{"text too long", func(d *Composition) { l := textLayer("a"); l.Text.Text = long; d.Layers = []Layer{l} }, true},
		{"text unicode limit", func(d *Composition) {
			l := textLayer("a")
			l.Text.Text = strings.Repeat("é", MaxTextChars)
			d.Layers = []Layer{l}
		}, false},
		{"font", func(d *Composition) { l := textLayer("a"); l.Text.Font = "Comic Sans"; d.Layers = []Layer{l} }, true},
		{"text colour", func(d *Composition) { l := textLayer("a"); l.Text.Color = "#fff"; d.Layers = []Layer{l} }, true},
		{"align", func(d *Composition) { l := textLayer("a"); l.Text.Align = "justify"; d.Layers = []Layer{l} }, true},
		{"line height", func(d *Composition) { l := textLayer("a"); l.Text.LineHeight = 3; d.Layers = []Layer{l} }, true},
		{"pill ok", func(d *Composition) { l := textLayer("a"); l.Text.Pill = "#112233"; d.Layers = []Layer{l} }, false},
		{"pill bad", func(d *Composition) { l := textLayer("a"); l.Text.Pill = "red"; d.Layers = []Layer{l} }, true},
		{"text layer without text", func(d *Composition) { l := textLayer("a"); l.Text = nil; d.Layers = []Layer{l} }, true},
		{"image layer without image", func(d *Composition) { l := imageLayer("a", "/x.png"); l.Image = nil; d.Layers = []Layer{l} }, true},
		{"image path", func(d *Composition) { d.Layers = []Layer{imageLayer("a", "")} }, true},
		{"crop out", func(d *Composition) {
			l := imageLayer("a", "/x")
			l.Image.Crop = Rect{0.5, 0, 0.8, 1}
			d.Layers = []Layer{l}
		}, true},
		{"crop empty", func(d *Composition) {
			l := imageLayer("a", "/x")
			l.Image.Crop = Rect{0, 0, 0, 1}
			d.Layers = []Layer{l}
		}, true},
		{"crop partial", func(d *Composition) {
			l := imageLayer("a", "/x")
			l.Image.Crop = Rect{0.25, 0.25, 0.5, 0.5}
			d.Layers = []Layer{l}
		}, false},
		{"radius", func(d *Composition) { l := imageLayer("a", "/x"); l.Image.Radius = 0.6; d.Layers = []Layer{l} }, true},
		{"shadow on needs colour", func(d *Composition) {
			l := textLayer("a")
			l.Shadow = Shadow{On: true, Opacity: 0.5}
			d.Layers = []Layer{l}
		}, true},
		{"shadow blur", func(d *Composition) { l := textLayer("a"); l.Shadow.Blur = 0.9; d.Layers = []Layer{l} }, true},
		{"outline width", func(d *Composition) {
			l := textLayer("a")
			l.Outline = Outline{On: true, Width: 0.5, Color: "#000000"}
			d.Layers = []Layer{l}
		}, true},
		{"outline ok", func(d *Composition) {
			l := textLayer("a")
			l.Outline = Outline{On: true, Width: 0.01, Color: "#000000"}
			d.Layers = []Layer{l}
		}, false},
	}
	for _, c := range cases {
		d := newDoc(t)
		c.mod(&d)
		err := Validate(d)
		if (err != nil) != c.bad {
			t.Errorf("%s: err=%v, want bad=%v", c.name, err, c.bad)
		}
		if err != nil {
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
				t.Errorf("%s: not a validation error: %v", c.name, err)
			}
		}
	}
}

func nan() float64 { z := 0.0; return z / z }

func TestSaveRoundTrip(t *testing.T) {
	e := setup(t)
	info, _ := e.svc.Create("A", "4:5", "")
	d := newDoc(t)
	d.Layers = []Layer{textLayer("a"), imageLayer("b", filepath.Join(t.TempDir(), "gone.png"))}
	saved, err := e.svc.Save(info.ID, "  Renamed   doc ", d)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Name != "Renamed doc" || saved.Items != 2 || saved.Missing != 1 {
		t.Errorf("info %+v", saved)
	}
	got, _ := e.svc.Get(info.ID)
	if len(got.Layers) != 2 || got.Layers[0].ID != "a" {
		t.Errorf("get %+v", got)
	}
	d.Layers[0].Opacity = 7
	if _, err := e.svc.Save(info.ID, "x", d); err == nil {
		t.Error("invalid doc saved")
	}
	// A nil layer list is stored as an empty list.
	d = newDoc(t)
	d.Layers = nil
	if _, err := e.svc.Save(info.ID, "x", d); err != nil {
		t.Errorf("nil layers: %v", err)
	}
	if _, err := e.svc.Save("nope", "x", newDoc(t)); err == nil {
		t.Error("save into missing project")
	}
}

func encodePNG(w, h int, alpha uint8) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = 10, 120, 200, alpha
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func encodeJPEG(w, h int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+3] = 200, 255
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	return buf.Bytes()
}

func TestSaveRender(t *testing.T) {
	e := setup(t)
	info, _ := e.svc.Create("R", "4:5", "")
	b64 := func(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

	if err := e.svc.SaveRender(info.ID, "png", b64(encodePNG(1080, 1350, 255))); err != nil {
		t.Fatal(err)
	}
	dir := e.m.docs.Dir(info.ID)
	if _, err := os.Stat(filepath.Join(dir, "render.png")); err != nil {
		t.Error("render.png missing")
	}
	f, err := os.Open(filepath.Join(dir, "thumb.jpg"))
	if err != nil {
		t.Fatal("thumb missing")
	}
	cfg, err := jpeg.DecodeConfig(f)
	f.Close()
	if err != nil || max(cfg.Width, cfg.Height) != ThumbDim || cfg.Width >= cfg.Height {
		t.Errorf("thumb %+v %v", cfg, err)
	}
	if p, err := e.m.RenderPath(info.ID); err != nil || filepath.Base(p) != "render.png" {
		t.Errorf("RenderPath %q %v", p, err)
	}
	// Switching format replaces the other file; data URLs are accepted.
	if err := e.svc.SaveRender(info.ID, "jpg", "data:image/jpeg;base64,"+b64(encodeJPEG(100, 100))); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "render.png")); !os.IsNotExist(err) {
		t.Error("old render.png not removed")
	}
	if p, _ := e.m.RenderPath(info.ID); filepath.Base(p) != "render.jpg" {
		t.Errorf("RenderPath %q", p)
	}
	if info2, _ := e.svc.List(); len(info2) == 0 || info2[0].Thumb == "" {
		t.Error("listing has no thumb")
	}

	bad := []struct {
		name, format, data string
	}{
		{"format", "gif", b64(encodePNG(4, 4, 255))},
		{"not base64", "png", "@@@"},
		{"not an image", "png", b64([]byte("hello"))},
		{"mismatch", "jpg", b64(encodePNG(4, 4, 255))},
		{"too big", "png", strings.Repeat("A", MaxRenderBytes*2)},
	}
	for _, c := range bad {
		if err := e.svc.SaveRender(info.ID, c.format, c.data); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}
	if err := e.svc.SaveRender("missing", "png", b64(encodePNG(4, 4, 255))); err == nil {
		t.Error("missing project accepted")
	}
	// Decoded size cap: a valid PNG padded past 40 MB.
	padded := append(encodePNG(8, 8, 255), make([]byte, MaxRenderBytes)...)
	if err := e.svc.SaveRender(info.ID, "png", b64(padded)); err == nil {
		t.Error("oversize render accepted")
	}
	// A transparent render gets a thumb on white (no alpha loss crash).
	if err := e.svc.SaveRender(info.ID, "png", b64(encodePNG(30, 30, 0))); err != nil {
		t.Fatal(err)
	}
}

func TestRenderPathNotFound(t *testing.T) {
	e := setup(t)
	info, _ := e.svc.Create("R", "4:5", "")
	_, err := e.m.RenderPath(info.ID)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeNotFound {
		t.Errorf("err %v", err)
	}
}

func TestExport(t *testing.T) {
	e := setup(t)
	info, _ := e.svc.Create(`Shirts: "market"?`, "4:5", "")
	if _, err := e.svc.Export(info.ID); err == nil {
		t.Error("export without render")
	}
	if err := e.svc.SaveRender(info.ID, "jpg", base64.StdEncoding.EncodeToString(encodeJPEG(64, 80))); err != nil {
		t.Fatal(err)
	}
	o1, err := e.svc.Export(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	o2, err := e.svc.Export(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(o1.Path) != filepath.Join(e.lib, "Compositions") || filepath.Base(o1.Path) != "Shirts_ _market__.jpg" {
		t.Errorf("path %q", o1.Path)
	}
	if o1.Path == o2.Path || !strings.HasSuffix(o2.Path, " (1).jpg") {
		t.Errorf("second export %q", o2.Path)
	}
	if o1.ModuleID != ModuleID || o1.Kind != core.KindImage {
		t.Errorf("output %+v", o1)
	}
	if _, err := os.Stat(o1.Path); err != nil {
		t.Error(err)
	}
	got, err := e.db.GetOutput(context.Background(), o1.ID)
	if err != nil || got.Path != o1.Path {
		t.Errorf("not registered: %v", err)
	}
	e.em.mu.Lock()
	defer e.em.mu.Unlock()
	n := 0
	for _, ev := range e.em.events {
		if ev == core.EventLibraryAdded {
			n++
		}
	}
	if n != 2 {
		t.Errorf("library:added events: %d", n)
	}
}

func decodeURL(t *testing.T, url string) (image.Image, string) {
	t.Helper()
	i := strings.Index(url, ";base64,")
	if !strings.HasPrefix(url, "data:image/") || i < 0 {
		t.Fatalf("not a data URL: %.40s", url)
	}
	b, err := base64.StdEncoding.DecodeString(url[i+8:])
	if err != nil {
		t.Fatal(err)
	}
	img, format, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return img, format
}

func TestLoadImage(t *testing.T) {
	e := setup(t)
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	big := write("big.png", encodePNG(800, 400, 255))
	url, err := e.svc.LoadImage(big, 200)
	if err != nil {
		t.Fatal(err)
	}
	img, format := decodeURL(t, url)
	if format != "jpeg" || img.Bounds().Dx() != 200 || img.Bounds().Dy() != 100 {
		t.Errorf("opaque: %s %v", format, img.Bounds())
	}
	// Never enlarged.
	small := write("small.png", encodePNG(100, 50, 255))
	url, _ = e.svc.LoadImage(small, 2048)
	if img, _ := decodeURL(t, url); img.Bounds().Dx() != 100 {
		t.Errorf("enlarged: %v", img.Bounds())
	}
	// Alpha stays PNG.
	alpha := write("alpha.png", encodePNG(100, 100, 100))
	url, _ = e.svc.LoadImage(alpha, 64)
	if img, format := decodeURL(t, url); format != "png" || img.Bounds().Dx() != 64 {
		t.Errorf("alpha: %s %v", format, img.Bounds())
	}
	// EXIF orientation 6 turns a landscape JPEG into a portrait.
	rot := write("rot.jpg", jpegWithOrientation(t, 60, 30, 6))
	url, _ = e.svc.LoadImage(rot, 2048)
	if img, _ := decodeURL(t, url); img.Bounds().Dx() != 30 || img.Bounds().Dy() != 60 {
		t.Errorf("orientation: %v", img.Bounds())
	}

	// Cache: an identical request is served from disk; a changed file isn't.
	entries, _ := os.ReadDir(e.m.cfg.CacheDir)
	before := len(entries)
	if before != 4 {
		t.Errorf("cache entries: %d", before)
	}
	if _, err := e.svc.LoadImage(big, 200); err != nil {
		t.Fatal(err)
	}
	if entries, _ = os.ReadDir(e.m.cfg.CacheDir); len(entries) != before {
		t.Error("cache hit wrote a new entry")
	}
	if _, err := e.svc.LoadImage(big, 300); err != nil {
		t.Fatal(err)
	}
	if entries, _ = os.ReadDir(e.m.cfg.CacheDir); len(entries) != before+1 {
		t.Error("different maxDim shares a cache entry")
	}
	later := time.Now().Add(time.Hour)
	write("big.png", encodePNG(800, 400, 255))
	_ = os.Chtimes(big, later, later)
	if _, err := e.svc.LoadImage(big, 200); err != nil {
		t.Fatal(err)
	}
	if entries, _ = os.ReadDir(e.m.cfg.CacheDir); len(entries) != before+2 {
		t.Error("changed mtime reused the cache")
	}

	for name, c := range map[string]struct {
		path string
		dim  int
	}{
		"relative": {"x.png", 200},
		"missing":  {filepath.Join(dir, "none.png"), 200},
		"small":    {big, 32},
		"large":    {big, 5000},
		"type":     {write("a.txt", []byte("x")), 200},
		"corrupt":  {write("bad.png", []byte("not a png")), 200},
	} {
		if _, err := e.svc.LoadImage(c.path, c.dim); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// jpegWithOrientation encodes a w×h JPEG with an EXIF orientation tag.
func jpegWithOrientation(t *testing.T, w, h int, o uint16) []byte {
	t.Helper()
	raw := encodeJPEG(w, h)
	var tiff bytes.Buffer
	tiff.WriteString("MM")
	_ = binary.Write(&tiff, binary.BigEndian, uint16(42))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(8))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(1))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0x0112))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(3))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(1))
	_ = binary.Write(&tiff, binary.BigEndian, o)
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(0))
	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	var out bytes.Buffer
	out.Write(raw[:2])
	out.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&out, binary.BigEndian, uint16(len(payload)+2))
	out.Write(payload)
	out.Write(raw[2:])
	return out.Bytes()
}

func TestLoadImageHEIC(t *testing.T) {
	e := setup(t)
	p := filepath.Join(t.TempDir(), "IMG_1.HEIC")
	if err := os.WriteFile(p, []byte("heic bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	url, err := e.svc.LoadImage(p, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if img, _ := decodeURL(t, url); img.Bounds().Dx() != 40 {
		t.Errorf("bounds %v", img.Bounds())
	}
	// A second size reuses the converted PNG.
	if _, err := e.svc.LoadImage(p, 64); err != nil {
		t.Fatal(err)
	}
	if e.eng.count() != 1 {
		t.Errorf("engine called %d times", e.eng.count())
	}

	// No engine: a dependency-missing error with the install hint.
	e.m.cfg.Engine = nil
	p2 := filepath.Join(t.TempDir(), "b.heic")
	_ = os.WriteFile(p2, []byte("x"), 0o644)
	_, err = e.svc.LoadImage(p2, 2048)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing || !strings.Contains(ae.Hint, "Image pack") {
		t.Errorf("no engine: %v", err)
	}
	// An engine that reports itself missing maps to the same hint.
	e.m.cfg.Engine = &fakeEngine{err: core.ErrDependencyMissing(sidecar.DepID, "install it")}
	_, err = e.svc.LoadImage(p2, 2048)
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing || !strings.Contains(ae.Hint, "Image pack") {
		t.Errorf("engine missing: %v", err)
	}
}

func TestRemoveBackground(t *testing.T) {
	e := setup(t)
	p := filepath.Join(t.TempDir(), "shirt.jpg")
	_ = os.WriteFile(p, encodeJPEG(10, 10), 0o644)
	job, err := e.svc.RemoveBackground(p)
	if err != nil {
		t.Fatal(err)
	}
	if job.ModuleID != bgremove.ModuleID || len(job.Inputs) != 1 || job.Inputs[0] != p {
		t.Errorf("job %+v", job)
	}
	var o bgremove.Options
	if err := json.Unmarshal([]byte(e.bg.opts), &o); err != nil {
		t.Fatal(err)
	}
	if o.Model != bgremove.ModelBalanced || o.Output != bgremove.OutputTransparent || !o.Crop || o.Padding != 0 || !o.CleanEdges {
		t.Errorf("options %+v", o)
	}
	if _, err := e.svc.RemoveBackground("rel.jpg"); err == nil {
		t.Error("relative path accepted")
	}
	if _, err := e.svc.RemoveBackground(filepath.Join(t.TempDir(), "nope.jpg")); err == nil {
		t.Error("missing file accepted")
	}
}

func TestDuplicateDelete(t *testing.T) {
	e := setup(t)
	info, _ := e.svc.Create("A", "1:1", "")
	_ = e.svc.SaveRender(info.ID, "png", base64.StdEncoding.EncodeToString(encodePNG(10, 10, 255)))
	cp, err := e.svc.Duplicate(info.ID)
	if err != nil || cp.Name != "A copy" {
		t.Fatalf("%v %+v", err, cp)
	}
	if _, err := e.m.RenderPath(cp.ID); err != nil {
		t.Errorf("copy lost render: %v", err)
	}
	if err := e.svc.Delete(info.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.m.docs.Dir(info.ID)); !os.IsNotExist(err) {
		t.Error("folder not removed")
	}
}
