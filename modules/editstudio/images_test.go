package editstudio

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/imaging"
)

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// writePNG writes a w×h PNG (translucent in its left half when alpha).
func writePNG(t *testing.T, path string, w, h int, alpha bool) string {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(255)
			if alpha && x < w/2 {
				a = 100
			}
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 4), G: uint8(y * 4), B: 90, A: a})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	return path
}

// writeOrientedJPEG writes a w×h JPEG carrying an EXIF orientation tag.
func writeOrientedJPEG(t *testing.T, path string, w, h, orientation int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: uint8(x), B: uint8(y), A: 255})
		}
	}
	tmp := filepath.Join(t.TempDir(), "plain.jpg")
	f, err := os.Create(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	f.Close()
	plain, _ := os.ReadFile(tmp)
	// APP1 Exif: TIFF big-endian, one IFD0 entry (0x0112 Orientation, SHORT 1).
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(tiff[18:], uint16(orientation))
	seg := append([]byte("Exif\x00\x00"), tiff...)
	app1 := []byte{0xff, 0xe1, byte((len(seg) + 2) >> 8), byte(len(seg) + 2)}
	out := append([]byte{0xff, 0xd8}, app1...)
	out = append(out, seg...)
	out = append(out, plain[2:]...)
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func imageSize(t *testing.T, path string) (int, int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

func TestEnsureImage(t *testing.T) {
	ctx := context.Background()
	t.Run("opaque photo becomes a capped JPEG", func(t *testing.T) {
		m := newTestModule(t)
		src := writePNG(t, filepath.Join(t.TempDir(), "p.png"), 200, 100, false)
		if m.ImageFor(src, 64) != "" {
			t.Fatal("not made yet")
		}
		out, err := m.EnsureImage(ctx, nil, src, 64)
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(out) != "img-64.jpg" {
			t.Errorf("name %s", out)
		}
		if w, h := imageSize(t, out); w != 64 || h != 32 {
			t.Errorf("size %dx%d, want 64x32", w, h)
		}
		if m.ImageFor(src, 64) != out || m.ImageFor(src, 128) != "" {
			t.Error("ImageFor")
		}
		before, _ := os.Stat(out)
		again, err := m.EnsureImage(ctx, nil, src, 64)
		if err != nil || again != out {
			t.Fatal(err)
		}
		if after, _ := os.Stat(out); !after.ModTime().Equal(before.ModTime()) {
			t.Error("must reuse, not rewrite")
		}
	})
	t.Run("alpha stays PNG and small images are not enlarged", func(t *testing.T) {
		m := newTestModule(t)
		src := writePNG(t, filepath.Join(t.TempDir(), "a.png"), 40, 20, true)
		out, err := m.EnsureImage(ctx, nil, src, 1920)
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(out) != "img-1920.png" {
			t.Errorf("name %s", out)
		}
		if w, h := imageSize(t, out); w != 40 || h != 20 {
			t.Errorf("size %dx%d", w, h)
		}
	})
	t.Run("EXIF orientation is applied", func(t *testing.T) {
		m := newTestModule(t)
		src := writeOrientedJPEG(t, filepath.Join(t.TempDir(), "o.jpg"), 80, 40, 6)
		if imaging.Orientation(src) != 6 {
			t.Fatal("the test file lost its orientation")
		}
		out, err := m.EnsureImage(ctx, nil, src, 1920)
		if err != nil {
			t.Fatal(err)
		}
		if w, h := imageSize(t, out); w != 40 || h != 80 {
			t.Errorf("size %dx%d, want 40x80 (rotated upright)", w, h)
		}
	})
	t.Run("errors", func(t *testing.T) {
		m := newTestModule(t)
		if _, err := m.EnsureImage(ctx, nil, filepath.Join(t.TempDir(), "gone.jpg"), 64); !core.IsCode(err, core.CodeNotFound) {
			t.Errorf("missing: %v", err)
		}
		bad := filepath.Join(t.TempDir(), "bad.jpg")
		_ = os.WriteFile(bad, []byte("not an image"), 0o644)
		if _, err := m.EnsureImage(ctx, nil, bad, 64); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("garbage: %v", err)
		}
		heic := filepath.Join(t.TempDir(), "x.heic")
		_ = os.WriteFile(heic, []byte("heic"), 0o644)
		imaging.SetHEICConverter(nil)
		if _, err := m.EnsureImage(ctx, nil, heic, 64); !core.IsCode(err, core.CodeDependencyMissing) {
			t.Errorf("HEIC without a converter: %v", err)
		}
		if _, err := m.EnsureImage(ctx, nil, bad, 4); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("tiny cap: %v", err)
		}
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		src := writePNG(t, filepath.Join(t.TempDir(), "p.png"), 20, 20, false)
		if _, err := m.EnsureImage(cctx, nil, src, 64); err == nil {
			t.Error("a cancelled context must stop")
		}
	})
}
