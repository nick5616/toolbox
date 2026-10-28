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

	"golang.org/x/image/bmp"
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
		{filepath.Join(dir, "x.heic"), "No preview for HEIC"},
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
