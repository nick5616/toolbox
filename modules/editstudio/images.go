package editstudio

import (
	"context"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"

	xdraw "golang.org/x/image/draw"

	"toolbox/core"
	"toolbox/core/imaging"
)

// Edit images: upright, size-capped, HEIC converted (SPEC.md §7.3). WP-ES4.

// Image caps (long side).
const (
	PreviewImageMax = 1920
	ExportImageMax  = 4096
)

const imageQuality = 92

func imageBase(maxDim int) string { return fmt.Sprintf("img-%d", maxDim) }

// ImageFor returns an existing edit image, or "".
func (m *Module) ImageFor(path string, maxDim int) string {
	dir, err := m.srcDir(path)
	if err != nil {
		return ""
	}
	for _, ext := range []string{".jpg", ".png"} {
		p := filepath.Join(dir, imageBase(maxDim)+ext)
		if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
			touchDir(dir)
			return p
		}
	}
	return ""
}

// EnsureImage makes (or reuses) the edit image of a photo at a long-side cap.
func (m *Module) EnsureImage(ctx context.Context, job *core.JobContext, path string, maxDim int) (string, error) {
	if maxDim < 16 {
		return "", core.ValidationError("Bad image size", map[string]string{"maxDim": "Bad image size"})
	}
	if p := m.ImageFor(path, maxDim); p != "" {
		return p, nil
	}
	dir, err := m.srcDir(path)
	if err != nil {
		return "", err
	}
	unlock, err := m.lockKey(ctx, filepath.Join(dir, imageBase(maxDim)))
	if err != nil {
		return "", err
	}
	defer unlock()
	if p := m.ImageFor(path, maxDim); p != "" {
		return p, nil
	}
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return "", err
	}
	img, err := decodeCapped(readable, maxDim)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	ext := ".jpg"
	if !img.Opaque() {
		ext = ".png"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create the cache folder").WithCause(err)
	}
	out := filepath.Join(dir, imageBase(maxDim)+ext)
	part := out + ".part"
	f, err := os.Create(part)
	if err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't save the picture").WithCause(err)
	}
	if ext == ".png" {
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(f, img)
	} else {
		err = jpeg.Encode(f, img, &jpeg.Options{Quality: imageQuality})
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(part, out)
	}
	if err != nil {
		_ = os.Remove(part)
		return "", core.Errorf(core.CodeInternal, "Couldn't save the picture").WithCause(err)
	}
	touchDir(dir)
	return out, nil
}

// decodeCapped reads an image, scales it so its long side is at most maxDim
// and applies the EXIF orientation.
func decodeCapped(path string, maxDim int) (*image.NRGBA, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, core.Errorf(core.CodeNotFound, "This file doesn't exist any more").WithHint(path).WithCause(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "Couldn't read this picture").WithHint(filepath.Base(path)).WithCause(err)
	}
	if int64(cfg.Width)*int64(cfg.Height) > imaging.MaxPixels {
		return nil, core.Errorf(core.CodeValidation, "This picture is too large").WithHint(filepath.Base(path))
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, fmt.Errorf("rewinding %s: %w", filepath.Base(path), err)
	}
	src, _, err := image.Decode(f)
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "Couldn't read this picture").WithHint(filepath.Base(path)).WithCause(err)
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	var dst *image.NRGBA
	if long := max(w, h); long > maxDim {
		nw := max(1, int(float64(w)*float64(maxDim)/float64(long)+0.5))
		nh := max(1, int(float64(h)*float64(maxDim)/float64(long)+0.5))
		dst = image.NewNRGBA(image.Rect(0, 0, nw, nh))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, xdraw.Src, nil)
	} else {
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
	}
	if o := imaging.Orientation(path); o > 1 {
		if n, ok := imaging.Orient(dst, o).(*image.NRGBA); ok {
			dst = n
		}
	}
	return dst, nil
}
