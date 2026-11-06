package imagebatch

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

func TestPlanLayout(t *testing.T) {
	base := DefaultOptions()
	tests := []struct {
		name         string
		w, h         int
		mod          func(*Options)
		canvas       image.Point
		content      image.Point
		offset       image.Point
		crop         image.Rectangle
		cropOverride bool
	}{
		{"long side down", 4000, 3000, func(o *Options) {}, image.Pt(2048, 1536), image.Pt(2048, 1536), image.Pt(0, 0), image.Rect(0, 0, 4000, 3000), true},
		{"portrait long side", 3000, 4000, func(o *Options) { o.LongSide = 1000 }, image.Pt(750, 1000), image.Pt(750, 1000), image.Pt(0, 0), image.Rect(0, 0, 3000, 4000), true},
		{"no enlarge", 800, 600, func(o *Options) {}, image.Pt(800, 600), image.Pt(800, 600), image.Pt(0, 0), image.Rect(0, 0, 800, 600), true},
		{"enlarge allowed", 800, 600, func(o *Options) { o.NoEnlarge = false }, image.Pt(2048, 1536), image.Pt(2048, 1536), image.Pt(0, 0), image.Rect(0, 0, 800, 600), true},
		{"keep size", 800, 600, func(o *Options) { o.Resize = ResizeKeep }, image.Pt(800, 600), image.Pt(800, 600), image.Pt(0, 0), image.Rect(0, 0, 800, 600), true},
		{"square crop", 4000, 3000, func(o *Options) { o.Resize = ResizeKeep; o.Aspect = "1:1" }, image.Pt(3000, 3000), image.Pt(3000, 3000), image.Pt(0, 0), image.Rect(500, 0, 3500, 3000), true},
		{"square crop then long side", 4000, 3000, func(o *Options) { o.LongSide = 1080; o.Aspect = "1:1" }, image.Pt(1080, 1080), image.Pt(1080, 1080), image.Pt(0, 0), image.Rect(500, 0, 3500, 3000), true},
		{"square pad", 4000, 3000, func(o *Options) { o.Resize = ResizeKeep; o.Aspect = "1:1"; o.Fit = FitPad }, image.Pt(4000, 4000), image.Pt(4000, 3000), image.Pt(0, 500), image.Rect(0, 0, 4000, 3000), true},
		{"4:5 pad of a portrait that is thinner", 800, 1200, func(o *Options) { o.Resize = ResizeKeep; o.Aspect = "4:5"; o.Fit = FitPad }, image.Pt(960, 1200), image.Pt(800, 1200), image.Pt(80, 0), image.Rect(0, 0, 800, 1200), true},
		{"pad then long side", 4000, 3000, func(o *Options) { o.LongSide = 1000; o.Aspect = "1:1"; o.Fit = FitPad }, image.Pt(1000, 1000), image.Pt(1000, 750), image.Pt(0, 125), image.Rect(0, 0, 4000, 3000), true},
		{"exact crop", 4000, 3000, func(o *Options) { o.Resize = ResizeExact; o.Width = 1080; o.Height = 1350 }, image.Pt(1080, 1350), image.Pt(1080, 1350), image.Pt(0, 0), image.Rect(800, 0, 3200, 3000), true},
		{"exact pad", 4000, 3000, func(o *Options) { o.Resize = ResizeExact; o.Width = 1000; o.Height = 1000; o.Fit = FitPad }, image.Pt(1000, 1000), image.Pt(1000, 750), image.Pt(0, 125), image.Rect(0, 0, 4000, 3000), true},
		{"exact pad enlarges", 100, 50, func(o *Options) { o.Resize = ResizeExact; o.Width = 400; o.Height = 400; o.Fit = FitPad }, image.Pt(400, 400), image.Pt(400, 200), image.Pt(0, 100), image.Rect(0, 0, 100, 50), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			o := base
			tc.mod(&o)
			l := PlanLayout(tc.w, tc.h, o)
			if l.Canvas != tc.canvas || l.Content != tc.content || l.Offset != tc.offset || l.Crop != tc.crop {
				t.Fatalf("got %+v", l)
			}
		})
	}
}

func TestLayoutScaled(t *testing.T) {
	l := PlanLayout(4000, 3000, func() Options { o := DefaultOptions(); o.LongSide = 2000; o.Aspect = "1:1"; o.Fit = FitPad; return o }())
	s := l.Scaled(0.5)
	if s.Canvas != image.Pt(1000, 1000) || s.Content != image.Pt(1000, 750) || s.Offset != image.Pt(0, 125) {
		t.Fatalf("%+v", s)
	}
	if l.Scaled(2) != l {
		t.Error("scaled up")
	}
}

func TestPlaceWatermark(t *testing.T) {
	canvas := image.Pt(1000, 500) // margin 2% of 500 = 10
	tests := []struct {
		c    Corner
		want image.Point
	}{
		{CornerTopLeft, image.Pt(10, 10)},
		{CornerTopRight, image.Pt(1000-200-10, 10)},
		{CornerBottomLeft, image.Pt(10, 500-50-10)},
		{CornerBottomRight, image.Pt(790, 440)},
		{CornerCenter, image.Pt(400, 225)},
	}
	for _, tc := range tests {
		if got := PlaceWatermark(canvas, 200, 50, tc.c); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.c, got, tc.want)
		}
	}
	if got := PlaceWatermark(image.Pt(100, 100), 300, 300, CornerBottomRight); got.X < 0 || got.Y < 0 {
		t.Errorf("negative placement %v", got)
	}
}

func TestExpandName(t *testing.T) {
	now := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		pattern, name string
		n, total      int
		want          string
	}{
		{"{name}", "IMG_1", 1, 3, "IMG_1"},
		{"", "IMG_1", 1, 3, "IMG_1"},
		{"{name}-web", "IMG_1", 1, 3, "IMG_1-web"},
		{"trip-{n}", "IMG_1", 7, 120, "trip-007"},
		{"{date}_{name}", "a", 1, 1, "2026-03-09_a"},
		{"a/b:c", "x", 1, 1, "a_b_c"},
		{"{unknown}", "x", 1, 1, "x"},
		{"  ..  ", "x", 1, 1, "x"},
	}
	for _, tc := range tests {
		if got := ExpandName(tc.pattern, tc.name, tc.n, tc.total, now); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.pattern, got, tc.want)
		}
	}
	if got := ExpandName(strings.Repeat("é", 150), "x", 1, 1, now); len(got) > 180 || strings.ContainsRune(got, '�') {
		t.Errorf("long name not cut on a rune: %d bytes", len(got))
	}
}

func TestOptionsValidate(t *testing.T) {
	if err := DefaultOptions().Validate(); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(*Options){
		"longSide":    func(o *Options) { o.LongSide = 5 },
		"width":       func(o *Options) { o.Resize = ResizeExact; o.Width = 0 },
		"aspect":      func(o *Options) { o.Aspect = "7:3" },
		"fit":         func(o *Options) { o.Fit = "x" },
		"background":  func(o *Options) { o.Background = "white" },
		"format":      func(o *Options) { o.Format = "gif" },
		"quality":     func(o *Options) { o.Quality = 0 },
		"watermark":   func(o *Options) { o.Watermark.Kind = WatermarkText },
		"watermark.y": func(o *Options) { o.Watermark.Kind = WatermarkText; o.Watermark.Text = "x"; o.Watermark.Font = "Comic" },
		"watermark.z": func(o *Options) { o.Watermark.Kind = WatermarkLogo },
	}
	for name, f := range bad {
		o := DefaultOptions()
		f(&o)
		if o.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	o := DefaultOptions()
	o.Watermark = Watermark{Kind: WatermarkText, Text: "© me", Font: "Arial", Color: "#fff000", Corner: CornerCenter, Opacity: 0.5, Size: 8}
	o.Background = "transparent"
	if err := o.Validate(); err != nil {
		t.Fatal(err)
	}
}

// exifBlock builds an Exif payload with an orientation tag (little endian).
func exifBlock(orientation uint16) []byte {
	var b bytes.Buffer
	b.WriteString("Exif\x00\x00")
	b.WriteString("II")
	binary.Write(&b, binary.LittleEndian, uint16(42))
	binary.Write(&b, binary.LittleEndian, uint32(8))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(0x0112))
	binary.Write(&b, binary.LittleEndian, uint16(3))
	binary.Write(&b, binary.LittleEndian, uint32(1))
	binary.Write(&b, binary.LittleEndian, orientation)
	binary.Write(&b, binary.LittleEndian, uint16(0))
	binary.Write(&b, binary.LittleEndian, uint32(0))
	return b.Bytes()
}

func jpegBytes(t *testing.T, w, h int, c color.Color) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExifRoundTrip(t *testing.T) {
	plain := jpegBytes(t, 8, 8, color.White)
	withExif := InjectExif(plain, exifBlock(6))
	got := exifFrom(withExif)
	if got == nil {
		t.Fatal("exif not found after injection")
	}
	// The orientation is reset to 1 because the pixels are already upright.
	if o := binary.LittleEndian.Uint16(got[6+8+2+8 : 6+8+2+10]); o != 1 {
		t.Fatalf("orientation %d", o)
	}
	if _, err := jpeg.Decode(bytes.NewReader(withExif)); err != nil {
		t.Fatalf("injected file doesn't decode: %v", err)
	}
	if !bytes.Equal(InjectExif(plain, nil), plain) || !bytes.Equal(InjectExif([]byte("nope"), exifBlock(1)), []byte("nope")) {
		t.Error("unusable input should be returned unchanged")
	}
	// After a JFIF segment the Exif goes behind it.
	jfif := append([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10}, append(make([]byte, 14), plain[2:]...)...)
	if exifFrom(InjectExif(jfif, exifBlock(3))) == nil {
		t.Error("exif lost after JFIF")
	}
}

func testEngine() *engine {
	return &engine{
		ffmpeg: func() (string, error) { return "", core.ErrDependencyMissing("ffmpeg", "no") },
		now:    func() time.Time { return time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC) },
	}
}

func writePNG(t *testing.T, path string, w, h int, c color.NRGBA) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func decodeOut(t *testing.T, path string) image.Image {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestProcessPadAndRename(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "red.png")
	writePNG(t, in, 400, 200, color.NRGBA{255, 0, 0, 255})
	o := DefaultOptions()
	o.Resize = ResizeExact
	o.Width, o.Height = 100, 100
	o.Fit = FitPad
	o.Background = "#0000ff"
	o.Format = FormatPNG
	o.Name = "{date}_{name}_{n}"
	out := filepath.Join(dir, "out")
	_ = os.MkdirAll(out, 0o755)
	fr, err := testEngine().processOne(context.Background(), in, o, nil, out, t.TempDir(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(fr.Output) != "2026-01-02_red_1.png" || fr.Width != 100 || fr.Height != 100 {
		t.Fatalf("%+v", fr)
	}
	img := decodeOut(t, fr.Output)
	r, g, b, _ := img.At(50, 50).RGBA() // inside the 100×50 band: red
	if r>>8 < 250 || g>>8 > 5 || b>>8 > 5 {
		t.Errorf("centre is not red: %d %d %d", r>>8, g>>8, b>>8)
	}
	r, g, b, _ = img.At(50, 5).RGBA() // padding: blue
	if b>>8 < 250 || r>>8 > 5 {
		t.Errorf("padding is not blue: %d %d %d", r>>8, g>>8, b>>8)
	}
	// A second run never overwrites.
	fr2, err := testEngine().processOne(context.Background(), in, o, nil, out, t.TempDir(), 0, 1)
	if err != nil || fr2.Output == fr.Output {
		t.Fatalf("second output %v %v", fr2.Output, err)
	}
}

func TestProcessJPEGFlattensAlphaAndKeepsExif(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "clear.png")
	writePNG(t, in, 64, 64, color.NRGBA{0, 0, 0, 0})
	o := DefaultOptions()
	o.Resize = ResizeKeep
	out := filepath.Join(dir, "out")
	fr, err := testEngine().processOne(context.Background(), in, o, nil, out, t.TempDir(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	r, g, b, _ := decodeOut(t, fr.Output).At(10, 10).RGBA()
	if r>>8 < 250 || g>>8 < 250 || b>>8 < 250 {
		t.Errorf("transparent area should become white, got %d %d %d", r>>8, g>>8, b>>8)
	}

	// JPEG with EXIF: kept only when Strip is off.
	src := filepath.Join(dir, "photo.jpg")
	if err := os.WriteFile(src, InjectExif(jpegBytes(t, 64, 32, color.NRGBA{10, 200, 10, 255}), exifBlock(1)), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, strip := range []bool{true, false} {
		o := DefaultOptions()
		o.Strip = strip
		o.Format = FormatSame
		fr, err := testEngine().processOne(context.Background(), src, o, nil, filepath.Join(dir, "o2"), t.TempDir(), 0, 1)
		if err != nil {
			t.Fatal(err)
		}
		if has := ReadExif(fr.Output) != nil; has == strip {
			t.Errorf("strip=%v but exif present=%v", strip, has)
		}
	}
}

func TestProcessLogo(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "base.png")
	writePNG(t, in, 200, 200, color.NRGBA{255, 255, 255, 255})
	logoPath := filepath.Join(dir, "logo.png")
	writePNG(t, logoPath, 20, 20, color.NRGBA{0, 0, 0, 255})
	o := DefaultOptions()
	o.Resize = ResizeKeep
	o.Format = FormatPNG
	o.Watermark = Watermark{Kind: WatermarkLogo, Logo: logoPath, Corner: CornerTopLeft, Opacity: 1, Size: 20}
	logo, err := loadLogo(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := testEngine().processOne(context.Background(), in, o, logo, filepath.Join(dir, "o"), t.TempDir(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	img := decodeOut(t, fr.Output)
	// Logo is 20% of 200 = 40 px, 4 px in from the corner (2% margin).
	if r, _, _, _ := img.At(20, 20).RGBA(); r>>8 > 5 {
		t.Errorf("logo missing at (20,20): %d", r>>8)
	}
	if r, _, _, _ := img.At(150, 150).RGBA(); r>>8 < 250 {
		t.Errorf("far corner changed: %d", r>>8)
	}
}

func TestProcessErrors(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "x.jpg")
	_ = os.WriteFile(bad, []byte("not a jpeg"), 0o644)
	_, err := testEngine().processOne(context.Background(), bad, DefaultOptions(), nil, dir, t.TempDir(), 0, 1)
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeValidation {
		t.Fatalf("got %v", err)
	}
	// WebP and text need FFmpeg: the missing tool is reported.
	in := filepath.Join(dir, "ok.png")
	writePNG(t, in, 20, 20, color.NRGBA{1, 2, 3, 255})
	o := DefaultOptions()
	o.Format = FormatWebP
	_, err = testEngine().processOne(context.Background(), in, o, nil, filepath.Join(dir, "o"), t.TempDir(), 0, 1)
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("got %v", err)
	}
}

func TestPreviewGoPath(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "big.png")
	writePNG(t, in, 3000, 2000, color.NRGBA{20, 40, 60, 255})
	s := NewService(nil, nil, dir)
	url, err := s.Preview(in, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "data:image/jpeg;base64,") {
		t.Fatalf("got %q", url[:30])
	}
	if _, err := s.Preview(in, Options{}); err == nil {
		t.Error("invalid options accepted")
	}
}

func TestPipeline(t *testing.T) {
	m := &Module{}
	info, err := m.DescribeStep(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 1 || info.Produces[0].Role != "image" || len(info.Produces[0].Exts) != 1 || info.Produces[0].Exts[0] != ".jpg" {
		t.Fatalf("%+v", info.Produces)
	}
	if len(info.Templates) != 2 {
		t.Fatalf("%v", info.Templates)
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"quality":500}`)); err == nil {
		t.Error("bad quality accepted")
	}

	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.png"), filepath.Join(dir, "b.png")
	writePNG(t, a, 4, 4, color.NRGBA{A: 255})
	writePNG(t, b, 4, 4, color.NRGBA{A: 255})
	opts := DefaultStepOptions()
	opts.Name = "{project}-{name}-{n}"
	opts.Watermark = Watermark{Kind: WatermarkText, Text: "{project} {name}", Font: "Arial", Color: "#ffffff", Corner: CornerBottomRight, Opacity: 0.5, Size: 5}
	raw, _ := json.Marshal(opts)
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: raw,
		Item:    core.StepItem{Files: []core.RunFile{{Path: a, Name: "a.png"}, {Path: b, Name: "b.png"}}, Vars: map[string]string{"project": "Trip"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("%+v", jobs)
	}
	got := jobs[0].Options.(Options)
	if got.Name != "Trip-{name}-{n}" || got.Watermark.Text != "Trip " {
		t.Fatalf("name %q text %q", got.Name, got.Watermark.Text)
	}
	one, _ := m.PrepareStep(context.Background(), core.StepRequest{
		Options: raw,
		Item:    core.StepItem{Files: []core.RunFile{{Path: a, Name: "a.png"}}, Vars: map[string]string{"project": "Trip"}},
	})
	if one[0].Options.(Options).Watermark.Text != "Trip a" {
		t.Errorf("single-file text %q", one[0].Options.(Options).Watermark.Text)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: raw}); err == nil {
		t.Error("no files accepted")
	}

	res, err := m.StepOutputs(core.Job{Outputs: []core.Output{{Path: "/o/a.jpg", Name: "a.jpg", ID: "x"}}})
	if err != nil || len(res.Files) != 1 || res.Files[0].Role != "image" {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestValidate(t *testing.T) {
	m := &Module{}
	if m.Validate(nil, nil) == nil {
		t.Error("no inputs accepted")
	}
	raw, _ := json.Marshal(DefaultOptions())
	if m.Validate([]string{"/x/a.txt"}, raw) == nil {
		t.Error("text file accepted")
	}
}
