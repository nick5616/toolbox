package pdf

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"golang.org/x/image/tiff"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func writeTIFF(t *testing.T, dir, name string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 99, 255})
		}
	}
	var buf bytes.Buffer
	if err := tiff.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// A 1x1 lossy WebP (VP8) image.
const tinyWebP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="

func writeWebP(t *testing.T, dir string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(tinyWebP)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "tiny.webp")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCompressNoisyJPEG(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	// A 2400x1800 noisy q95 JPEG on a Letter page: far above 150 dpi.
	jpg := noisyJPEG(t, dir, "scan.jpg", 2400, 1800, 95)
	src := filepath.Join(dir, "scan.pdf")
	if err := api.ImportImagesFile(t.Context(), []string{jpg, jpg}, src, nil, conf("")); err != nil {
		t.Fatal(err)
	}
	before := mustInfo(t, m, src, "")

	for _, lvl := range []string{LevelSmall, LevelBalanced, LevelHigh} {
		o := opts(ActionCompress)
		o.Level = lvl
		r, _, err := runJob(t, m, []string{src}, o)
		if err != nil {
			t.Fatalf("%s: %v", lvl, err)
		}
		if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "scan (compressed).pdf" {
			t.Fatalf("%s: outputs = %v (%s)", lvl, r.outputs, r.lastMessage())
		}
		after := mustInfo(t, m, r.outputs[0], "")
		res := r.res(t)
		t.Logf("%s: %d -> %d bytes, %d images, %q", lvl, before.Bytes, after.Bytes, res.ImagesRecompressed, r.lastMessage())
		if after.Pages != before.Pages || after.Bytes >= before.Bytes*95/100 || res.ImagesRecompressed < 1 {
			t.Errorf("%s: pages %d→%d bytes %d→%d images %d", lvl, before.Pages, after.Pages, before.Bytes, after.Bytes, res.ImagesRecompressed)
		}
		if res.BytesBefore != before.Bytes || res.BytesAfter != after.Bytes {
			t.Errorf("%s: result bytes = %d→%d, want %d→%d", lvl, res.BytesBefore, res.BytesAfter, before.Bytes, after.Bytes)
		}
		if !strings.Contains(r.lastMessage(), "→") || !strings.Contains(r.lastMessage(), "−") {
			t.Errorf("%s: message = %q", lvl, r.lastMessage())
		}
	}
}

func TestCompressAlreadyCompact(t *testing.T) {
	m := newTestModule(t)
	// Compress once at the smallest level; a second pass can't do better.
	dir := t.TempDir()
	jpg := noisyJPEG(t, dir, "scan.jpg", 1600, 1200, 90)
	raw := filepath.Join(dir, "raw.pdf")
	if err := api.ImportImagesFile(t.Context(), []string{jpg}, raw, nil, conf("")); err != nil {
		t.Fatal(err)
	}
	o := opts(ActionCompress)
	o.Level = LevelSmall
	first, _, err := runJob(t, m, []string{raw}, o)
	if err != nil || len(first.outputs) != 1 {
		t.Fatalf("first pass: %v %v", first.outputs, err)
	}
	r, out, err := runJob(t, m, []string{first.outputs[0]}, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 0 || len(listDir(t, out)) != 0 {
		t.Errorf("outputs = %v files = %v", r.outputs, listDir(t, out))
	}
	if !strings.HasPrefix(r.lastMessage(), "Already compact") {
		t.Errorf("message = %q", r.lastMessage())
	}
	if res := r.res(t); res.ImagesRecompressed != 0 || res.BytesAfter != res.BytesBefore {
		t.Errorf("result = %+v", res)
	}
}

func TestCMYKConversion(t *testing.T) {
	// Go's decoder yields 255-raw. Without /Decode, raw is the ink amount, so a
	// raw "no ink" pixel (0,0,0,0) = decoded (255,255,255,255) must be white.
	c := image.NewCMYK(image.Rect(0, 0, 1, 1))
	c.SetCMYK(0, 0, color.CMYK{255, 255, 255, 255})
	if got := cmykToRGBA(c, false).RGBAAt(0, 0); got != (color.RGBA{255, 255, 255, 255}) {
		t.Errorf("plain white = %v", got)
	}
	// With /Decode [1 0 ...] (Photoshop), raw 255 = no ink = decoded 0 → white.
	c.SetCMYK(0, 0, color.CMYK{0, 0, 0, 0})
	if got := cmykToRGBA(c, true).RGBAAt(0, 0); got != (color.RGBA{255, 255, 255, 255}) {
		t.Errorf("inverted white = %v", got)
	}
	// Full black ink (K) is black.
	c.SetCMYK(0, 0, color.CMYK{0, 0, 0, 255})
	if got := cmykToRGBA(c, true).RGBAAt(0, 0); got != (color.RGBA{0, 0, 0, 255}) {
		t.Errorf("inverted black = %v", got)
	}
}
