package imaging

import (
	"bytes"
	"encoding/base64"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	"golang.org/x/image/tiff"

	"toolbox/core"
)

func gradient(w, h int, alpha bool) *image.NRGBA {
	im := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			a := uint8(255)
			if alpha && x < w/2 {
				a = 0
			}
			im.SetNRGBA(x, y, color.NRGBA{uint8(x), uint8(y), 128, a})
		}
	}
	return im
}

func writeImage(t *testing.T, name string, im image.Image) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	var buf bytes.Buffer
	var err error
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		err = png.Encode(&buf, im)
	case ".jpg", ".jpeg":
		err = jpeg.Encode(&buf, im, nil)
	case ".bmp":
		err = bmp.Encode(&buf, im)
	case ".tif", ".tiff":
		err = tiff.Encode(&buf, im, nil)
	default:
		t.Fatalf("no encoder for %s", name)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func decodeURL(t *testing.T, url string) (string, image.Image) {
	t.Helper()
	mime, data, ok := strings.Cut(strings.TrimPrefix(url, "data:"), ";base64,")
	if !ok {
		t.Fatalf("not a data URL: %.40s", url)
	}
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		t.Fatal(err)
	}
	im, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return mime, im
}

func TestThumbFormatsAndScaling(t *testing.T) {
	cases := []struct {
		name         string
		im           image.Image
		maxDim       int
		wantMIME     string
		wantW, wantH int
	}{
		{"alpha.png", gradient(200, 100, true), 100, "image/png", 100, 50},
		{"opaque.png", gradient(200, 100, false), 100, "image/jpeg", 100, 50},
		{"photo.jpg", gradient(120, 240, false), 64, "image/jpeg", 32, 64},
		{"small.jpg", gradient(50, 40, false), 800, "image/jpeg", 50, 40}, // never upscaled
		{"pic.bmp", gradient(300, 300, false), 150, "image/jpeg", 150, 150},
		{"pic.tiff", gradient(300, 150, false), 10, "image/jpeg", 64, 32}, // maxDim clamped to 64
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := writeImage(t, c.name, c.im)
			url, err := NewThumbnailer().Thumb(p, c.maxDim)
			if err != nil {
				t.Fatal(err)
			}
			mime, im := decodeURL(t, url)
			if mime != c.wantMIME {
				t.Errorf("mime = %s, want %s", mime, c.wantMIME)
			}
			if b := im.Bounds(); b.Dx() != c.wantW || b.Dy() != c.wantH {
				t.Errorf("size = %dx%d, want %dx%d", b.Dx(), b.Dy(), c.wantW, c.wantH)
			}
		})
	}
}

func TestThumbCache(t *testing.T) {
	p := writeImage(t, "a.png", gradient(100, 100, false))
	th := NewThumbnailer()
	first, err := th.Thumb(p, 64)
	if err != nil {
		t.Fatal(err)
	}
	if th.lru.Len() != 1 {
		t.Fatalf("cache len = %d", th.lru.Len())
	}
	second, err := th.Thumb(p, 64)
	if err != nil || second != first || th.lru.Len() != 1 {
		t.Fatalf("cache miss on repeat (err %v, len %d)", err, th.lru.Len())
	}
	for i := range cacheEntries + 5 {
		th.put(string(rune('a'+i%26))+strings.Repeat("x", i), "u")
	}
	if th.lru.Len() != cacheEntries {
		t.Fatalf("cache not bounded: %d", th.lru.Len())
	}
}

func TestThumbUncachedLeavesCachesAlone(t *testing.T) {
	p := writeImage(t, "u.png", gradient(100, 100, false))
	th := Default()
	before := th.lru.Len()
	want, err := NewThumbnailer().Thumb(p, 64)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ThumbUncached(p, 64)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatal("uncached thumbnail differs from the cached builder's")
	}
	if th.lru.Len() != before {
		t.Fatalf("shared cache changed: %d -> %d", before, th.lru.Len())
	}
	if _, err := ThumbUncached(filepath.Join(t.TempDir(), "missing.png"), 64); err == nil {
		t.Fatal("missing file must fail")
	}
}

func TestThumbAndSizeErrors(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.png")
	if err := os.WriteFile(bad, []byte("not a png"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A PNG header claiming 20000×20000 (400 MP) with no pixel data.
	var hdr bytes.Buffer
	if err := png.Encode(&hdr, image.NewGray(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	b := hdr.Bytes()
	huge := append([]byte{}, b...)
	putU32 := func(off int, v uint32) {
		huge[off], huge[off+1], huge[off+2], huge[off+3] = byte(v>>24), byte(v>>16), byte(v>>8), byte(v)
	}
	putU32(16, 20000)                           // IHDR width
	putU32(20, 20000)                           // IHDR height
	putU32(29, crc32.ChecksumIEEE(huge[12:29])) // IHDR CRC over type + data
	hugePath := filepath.Join(dir, "huge.png")
	if err := os.WriteFile(hugePath, huge, 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		path, want string
	}{
		{filepath.Join(dir, "x.heic"), "Couldn't read this HEIC photo"}, // no converter registered
		{filepath.Join(dir, "x.txt"), "No preview for this file type"},
		{"relative.png", "No preview for this file type"},
		{filepath.Join(dir, "missing.png"), "doesn't exist"},
		{bad, "Couldn't read this image"},
		{hugePath, "Too large to preview"},
	}
	for _, c := range cases {
		_, err := NewThumbnailer().Thumb(c.path, 100)
		var ae *core.AppError
		if !errors.As(err, &ae) || !strings.Contains(ae.Message, c.want) {
			t.Errorf("Thumb(%s) = %v, want %q", filepath.Base(c.path), err, c.want)
		}
	}
	if s, err := Size(hugePath); err != nil || s.W != 20000 || s.H != 20000 {
		t.Errorf("Size(huge) = %+v, %v", s, err)
	}
	if _, err := Size(bad); err == nil {
		t.Error("Size(bad) succeeded")
	}
}

func TestSize(t *testing.T) {
	p := writeImage(t, "s.jpg", gradient(321, 123, false))
	s, err := Size(p)
	if err != nil || s != (core.Size{W: 321, H: 123}) {
		t.Fatalf("Size = %+v, %v", s, err)
	}
}

// meanDiff is the mean absolute difference of two same-sized images (0..255).
func meanDiff(t *testing.T, a, b image.Image) float64 {
	t.Helper()
	if a.Bounds().Size() != b.Bounds().Size() {
		t.Fatalf("sizes differ: %v vs %v", a.Bounds(), b.Bounds())
	}
	var sum, n float64
	for y := range a.Bounds().Dy() {
		for x := range a.Bounds().Dx() {
			ar, ag, ab, _ := a.At(a.Bounds().Min.X+x, a.Bounds().Min.Y+y).RGBA()
			br, bg, bb, _ := b.At(b.Bounds().Min.X+x, b.Bounds().Min.Y+y).RGBA()
			for _, d := range []int{int(ar>>8) - int(br>>8), int(ag>>8) - int(bg>>8), int(ab>>8) - int(bb>>8)} {
				sum += float64(max(d, -d))
				n++
			}
		}
	}
	return sum / n
}

func TestReduceLooksLikeTheFullScaler(t *testing.T) {
	// A big JPEG (YCbCr) and a big opaque NRGBA: the box pre-reduction ends
	// at (almost) the same picture as CatmullRom on the whole source.
	big := image.NewNRGBA(image.Rect(0, 0, 2400, 1500))
	for y := range 1500 {
		for x := range 2400 {
			big.SetNRGBA(x, y, color.NRGBA{uint8(x / 10), uint8(y / 6), uint8((x + y) / 16), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, big, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	ycc, err := jpeg.Decode(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ycc.(*image.YCbCr); !ok {
		t.Fatalf("expected a YCbCr image, got %T", ycc)
	}
	for _, src := range []image.Image{ycc, big} {
		r := reduce(src, 200)
		if r == src {
			t.Fatalf("%T was not reduced", src)
		}
		if b := r.Bounds(); b.Dx() != 400 || b.Dy() != 250 { // k = 2400 / 400 = 6
			t.Fatalf("%T reduced to %v", src, b)
		}
		if d := meanDiff(t, scale(r, 200), scale(src, 200)); d > 2 {
			t.Errorf("%T: mean difference %.2f", src, d)
		}
	}
	if small := gradient(300, 200, false); reduce(small, 100) != image.Image(small) {
		t.Error("an image under 4× the size is used as it is")
	}
}

func TestReduceKeepsTransparency(t *testing.T) {
	im := gradient(1000, 400, true) // left half transparent, right half opaque
	r := reduce(im, 100).(*image.NRGBA)
	if b := r.Bounds(); b.Dx() != 200 || b.Dy() != 80 {
		t.Fatalf("size %v", b)
	}
	if a := r.NRGBAAt(10, 10).A; a != 0 {
		t.Errorf("transparent block has alpha %d", a)
	}
	c := r.NRGBAAt(150, 40)
	if c.A != 255 || c.B != 128 {
		t.Errorf("opaque block = %+v", c)
	}
	edge := r.NRGBAAt(100, 40) // x 500..504: all opaque
	if edge.A != 255 {
		t.Errorf("edge = %+v", edge)
	}
	// Premultiplied RGBA averages to the same colours.
	rgba := image.NewRGBA(im.Bounds())
	draw.Draw(rgba, rgba.Bounds(), im, image.Point{}, draw.Src)
	r2 := reduce(rgba, 100).(*image.NRGBA)
	if got := r2.NRGBAAt(150, 40); got != c {
		t.Errorf("RGBA: %+v, NRGBA: %+v", got, c)
	}
}

func TestThumbDiskCache(t *testing.T) {
	dir := t.TempDir()
	p := writeImage(t, "a.png", gradient(300, 200, false))
	th := NewThumbnailer()
	th.SetDiskCache(dir)
	first, err := th.Thumb(p, 100)
	if err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*"+diskExt))
	if len(files) != 1 {
		t.Fatalf("cache files: %v", files)
	}
	// A new Thumbnailer (a restart) reads it back without decoding: mark the file to prove it.
	marked := "data:image/png;base64,TUFSSw=="
	if err := os.WriteFile(files[0], []byte(marked), 0o644); err != nil {
		t.Fatal(err)
	}
	again := NewThumbnailer()
	again.SetDiskCache(dir)
	if got, err := again.Thumb(p, 100); err != nil || got != marked {
		t.Fatalf("not read from disk: %v %.40s", err, got)
	}
	// Another size, or a changed file, is built anew.
	if got, _ := again.Thumb(p, 80); got == marked || got == "" {
		t.Error("another size must be built")
	}
	if err := os.Chtimes(p, time.Now().Add(time.Hour), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fresh := NewThumbnailer()
	fresh.SetDiskCache(dir)
	if got, err := fresh.Thumb(p, 100); err != nil || got == marked || got != first {
		t.Errorf("changed file: %v (same as marked: %v)", err, got == marked)
	}
	// Junk in the cache is ignored and rebuilt.
	for _, f := range mustGlob(t, filepath.Join(dir, "*"+diskExt)) {
		_ = os.WriteFile(f, []byte("junk"), 0o644)
	}
	junk := NewThumbnailer()
	junk.SetDiskCache(dir)
	if got, err := junk.Thumb(p, 100); err != nil || got != first {
		t.Errorf("junk not rebuilt: %v %.20s", err, got)
	}
}

func mustGlob(t *testing.T, pattern string) []string {
	t.Helper()
	m, err := filepath.Glob(pattern)
	if err != nil || len(m) == 0 {
		t.Fatalf("glob %s: %v %v", pattern, m, err)
	}
	return m
}

func TestPruneDisk(t *testing.T) {
	dir := t.TempDir()
	th := NewThumbnailer()
	th.SetDiskCache(dir)
	old := filepath.Join(dir, "old"+diskExt)
	part := filepath.Join(dir, "x"+diskExt+".part-0000")
	keep := filepath.Join(dir, "keep"+diskExt)
	for _, p := range []string{old, part, keep} {
		if err := os.WriteFile(p, []byte("data:image/png;base64,"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	long := time.Now().Add(-40 * 24 * time.Hour)
	_ = os.Chtimes(old, long, long)
	hour := time.Now().Add(-2 * time.Hour)
	_ = os.Chtimes(part, hour, hour)
	th.PruneDisk()
	for p, want := range map[string]bool{old: false, part: false, keep: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists = %v, want %v", filepath.Base(p), err == nil, want)
		}
	}
}
