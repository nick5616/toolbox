package mediaindex

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"os"
	"strings"

	xdraw "golang.org/x/image/draw"

	"toolbox/core"
	"toolbox/core/imaging"
)

// Picture sizes (SPEC.md §3.3).
const (
	embedShort   = 224  // the embedded copy's short side
	ocrLong      = 1600 // the OCR copy's long side
	jpegQuality  = 90
	bigImagePix  = 100_000_000 // above this, use imaging's reduce path
	maxImagePix  = imaging.MaxPixels
	maxImageSize = imaging.MaxFileBytes
)

// fitLong returns img scaled down so its long side is at most max (never
// upscaled). The big first step uses the fast scaler.
func fitLong(img image.Image, limit int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= limit && h <= limit {
		return img
	}
	if w >= h {
		h, w = max(1, h*limit/w), limit
	} else {
		w, h = max(1, w*limit/h), limit
	}
	return scaleTo(img, w, h, xdraw.ApproxBiLinear)
}

// fitShort returns img scaled down so its short side is at most short.
func fitShort(img image.Image, short int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if min(w, h) <= short {
		return img
	}
	if w <= h {
		h, w = max(1, h*short/w), short
	} else {
		w, h = max(1, w*short/h), short
	}
	return scaleTo(img, w, h, xdraw.CatmullRom)
}

func scaleTo(src image.Image, w, h int, s xdraw.Scaler) image.Image {
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	s.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	return dst
}

// writeJPEG saves img as a JPEG (q90), flattening transparency onto white.
func writeJPEG(path string, img image.Image) error {
	if o, ok := img.(interface{ Opaque() bool }); !ok || !o.Opaque() {
		b := img.Bounds()
		flat := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
		draw.Draw(flat, flat.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
		draw.Draw(flat, flat.Bounds(), img, b.Min, draw.Over)
		img = flat
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return fmt.Errorf("encode jpeg: %w", err)
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

// loadOriented reads a picture (HEIC via the registered converter), applies
// its EXIF orientation and returns it with its long side at most ocrLong.
func loadOriented(ctx context.Context, path string) (image.Image, error) {
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(readable)
	if err != nil {
		return nil, err
	}
	if fi.Size() > maxImageSize {
		return nil, core.ValidationError("Too large to read", nil)
	}
	f, err := os.Open(readable)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return nil, core.ValidationError("Couldn't read this picture", nil)
	}
	if int64(cfg.Width)*int64(cfg.Height) > maxImagePix {
		return nil, core.ValidationError("Too large to read", nil)
	}
	if int64(cfg.Width)*int64(cfg.Height) > bigImagePix {
		// imaging's reduce path (box-filters first, orients itself).
		url, err := imaging.ThumbUncached(readable, ocrLong)
		if err != nil {
			return nil, err
		}
		return decodeDataURL(url)
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, core.ValidationError("Couldn't read this picture", nil)
	}
	img = fitLong(img, ocrLong)
	if o := imaging.Orientation(readable); o > 1 {
		img = imaging.Orient(img, o)
	}
	return img, nil
}

func decodeDataURL(u string) (image.Image, error) {
	i := strings.IndexByte(u, ',')
	if i < 0 || !strings.HasPrefix(u, "data:") {
		return nil, core.ValidationError("Couldn't read this picture", nil)
	}
	raw, err := base64.StdEncoding.DecodeString(u[i+1:])
	if err != nil {
		return nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, core.ValidationError("Couldn't read this picture", nil)
	}
	return img, nil
}

// gifFrames returns the first and the middle frame of an animated GIF,
// composed over the previous frames, with the middle frame's start in ms.
// A still GIF gives one frame.
func gifFrames(path string) (first, mid image.Image, midMs int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, 0, err
	}
	defer f.Close()
	g, err := gif.DecodeAll(f)
	if err != nil || len(g.Image) == 0 {
		return nil, nil, 0, core.ValidationError("Couldn't read this picture", nil)
	}
	w, h := g.Config.Width, g.Config.Height
	if w == 0 || h == 0 {
		b := g.Image[0].Bounds()
		w, h = b.Max.X, b.Max.Y
	}
	if int64(w)*int64(h) > bigImagePix {
		return nil, nil, 0, core.ValidationError("Too large to read", nil)
	}
	target := len(g.Image) / 2
	canvas := image.NewRGBA(image.Rect(0, 0, w, h))
	var snapshots []image.Image
	for i, fr := range g.Image {
		var prev *image.RGBA
		if i < len(g.Disposal) && g.Disposal[i] == gif.DisposalPrevious {
			prev = cloneRGBA(canvas)
		}
		draw.Draw(canvas, fr.Bounds(), fr, fr.Bounds().Min, draw.Over)
		if i == 0 || i == target {
			snapshots = append(snapshots, cloneRGBA(canvas))
		}
		if i == target {
			break
		}
		if i < len(g.Disposal) {
			switch g.Disposal[i] {
			case gif.DisposalBackground:
				draw.Draw(canvas, fr.Bounds(), image.Transparent, image.Point{}, draw.Src)
			case gif.DisposalPrevious:
				if prev != nil {
					canvas = prev
				}
			}
		}
	}
	first = snapshots[0]
	if target == 0 {
		return first, nil, 0, nil
	}
	for i := 0; i < target && i < len(g.Delay); i++ {
		midMs += int64(g.Delay[i]) * 10
	}
	return first, snapshots[len(snapshots)-1], midMs, nil
}

func cloneRGBA(src *image.RGBA) *image.RGBA {
	dst := image.NewRGBA(src.Bounds())
	copy(dst.Pix, src.Pix)
	return dst
}

// isAnimatedWebP reports whether a WebP file has the animation flag.
func isAnimatedWebP(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var head [32]byte
	n, _ := f.Read(head[:])
	if n < 21 {
		return false
	}
	return string(head[0:4]) == "RIFF" && string(head[8:12]) == "WEBP" && string(head[12:16]) == "VP8X" && head[20]&0x02 != 0
}
