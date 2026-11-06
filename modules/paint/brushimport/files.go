package brushimport

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"path"
	"strings"
)

// ReadZip reads every file of a zip into memory, refusing unsafe entry names
// ("..", absolute paths, drive letters, backslash tricks) and capping the
// number of entries and the total uncompressed size (decompression bombs are
// caught by counting the bytes actually read, not the declared sizes).
// Entries of macOS resource forks (__MACOSX, .DS_Store) are skipped.
func ReadZip(data []byte) (map[string][]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("not a zip file: %w", err)
	}
	if len(zr.File) > MaxZipEntries {
		return nil, fmt.Errorf("zip has too many entries (%d)", len(zr.File))
	}
	out := make(map[string][]byte, len(zr.File))
	var total int64
	for _, f := range zr.File {
		name, err := SafeName(f.Name)
		if err != nil {
			return nil, err
		}
		if f.FileInfo().IsDir() || name == "" {
			continue
		}
		if strings.HasPrefix(name, "__MACOSX/") || path.Base(name) == ".DS_Store" {
			continue
		}
		if f.UncompressedSize64 > uint64(MaxZipTotal) || total+int64(f.UncompressedSize64) > MaxZipTotal {
			return nil, fmt.Errorf("zip is larger than %d MB when unpacked", MaxZipTotal>>20)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", name, err)
		}
		b, err := io.ReadAll(io.LimitReader(rc, MaxZipTotal-total+1))
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", name, err)
		}
		total += int64(len(b))
		if total > MaxZipTotal {
			return nil, fmt.Errorf("zip is larger than %d MB when unpacked", MaxZipTotal>>20)
		}
		out[name] = b
	}
	return out, nil
}

// SafeName cleans a zip entry name and rejects anything that could escape a
// folder. It returns forward-slash names without a leading "./".
func SafeName(name string) (string, error) {
	if strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("unsafe file name in zip: %q", name)
	}
	n := strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(n, "/") || (len(n) >= 2 && n[1] == ':') {
		return "", fmt.Errorf("unsafe file name in zip: %q", name)
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return "", fmt.Errorf("unsafe file name in zip: %q", name)
		}
	}
	return strings.TrimPrefix(path.Clean(n), "./"), nil
}

// decodePNG decodes a PNG within the size limits.
func decodePNG(data []byte) (image.Image, error) {
	if len(data) > MaxPNGBytes {
		return nil, errors.New("image is too large")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("not a PNG image: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > MaxImageSide || cfg.Height > MaxImageSide {
		return nil, fmt.Errorf("image is %d x %d px; the limit is %d", cfg.Width, cfg.Height, MaxImageSide)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decoding PNG: %w", err)
	}
	return img, nil
}

// ValidatePNG checks that data is a PNG within the limits.
func ValidatePNG(data []byte) (w, h int, err error) {
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, fmt.Errorf("not a PNG image: %w", err)
	}
	if len(data) > MaxPNGBytes || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > MaxImageSide || cfg.Height > MaxImageSide {
		return 0, 0, fmt.Errorf("image is %d x %d px; the limit is %d", cfg.Width, cfg.Height, MaxImageSide)
	}
	return cfg.Width, cfg.Height, nil
}

// luma returns 0..255 luminance of a pixel (non-premultiplied) and its alpha.
func luma(c color.Color) (l, a uint8) {
	n := color.NRGBAModel.Convert(c).(color.NRGBA)
	return uint8((299*int(n.R) + 587*int(n.G) + 114*int(n.B)) / 1000), n.A
}

// maskFromImage returns a w*h coverage mask (255 = paint). When the image has
// real transparency the alpha is the shape; otherwise the luminance is, and
// invertLum flips it (dark = paint). It also reports whether the source had
// transparency.
func maskFromImage(img image.Image, invertLum bool) (mask []uint8, w, h int, usedAlpha bool) {
	b := img.Bounds()
	w, h = b.Dx(), b.Dy()
	lum := make([]uint8, w*h)
	alpha := make([]uint8, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			l, a := luma(img.At(b.Min.X+x, b.Min.Y+y))
			lum[y*w+x], alpha[y*w+x] = l, a
			if a != 255 {
				usedAlpha = true
			}
		}
	}
	if usedAlpha {
		return alpha, w, h, true
	}
	if invertLum {
		for i := range lum {
			lum[i] = 255 - lum[i]
		}
	}
	return lum, w, h, false
}

// downscale averages blocks so the longest side is <= max. It returns the
// new size and whether it changed.
func downscale(mask []uint8, w, h, max int) ([]uint8, int, int, bool) {
	if w <= max && h <= max {
		return mask, w, h, false
	}
	f := (maxInt(w, h) + max - 1) / max
	nw, nh := (w+f-1)/f, (h+f-1)/f
	out := make([]uint8, nw*nh)
	for y := 0; y < nh; y++ {
		for x := 0; x < nw; x++ {
			sum, n := 0, 0
			for yy := y * f; yy < minInt(h, (y+1)*f); yy++ {
				for xx := x * f; xx < minInt(w, (x+1)*f); xx++ {
					sum += int(mask[yy*w+xx])
					n++
				}
			}
			out[y*nw+x] = uint8(sum / maxInt(n, 1))
		}
	}
	return out, nw, nh, true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// EncodeTip writes a coverage mask as the library's tip format: white paint
// with luminance = alpha = coverage.
func EncodeTip(mask []uint8, w, h int) ([]byte, error) {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i, v := range mask {
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = v, v, v, v
	}
	return encode(img)
}

// EncodeGrain writes a grayscale mask as an opaque PNG.
func EncodeGrain(mask []uint8, w, h int) ([]byte, error) {
	img := image.NewGray(image.Rect(0, 0, w, h))
	copy(img.Pix, mask)
	return encode(img)
}

func encode(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// TipFromPNG converts any PNG into a library tip. invertLum: dark = paint
// when the image has no transparency.
func TipFromPNG(data []byte, invertLum bool, n *notes) ([]byte, error) {
	img, err := decodePNG(data)
	if err != nil {
		return nil, err
	}
	mask, w, h, _ := maskFromImage(img, invertLum)
	mask, w, h, scaled := downscale(mask, w, h, MaxTipSide)
	if scaled && n != nil {
		n.add("Large tip images were scaled down to %d px.", MaxTipSide)
	}
	return EncodeTip(mask, w, h)
}

// GrainFromPNG converts any PNG into an opaque grayscale grain (transparent
// areas count as white).
func GrainFromPNG(data []byte, n *notes) ([]byte, error) {
	img, err := decodePNG(data)
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	flat := image.NewNRGBA(b)
	draw.Draw(flat, b, image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(flat, b, img, b.Min, draw.Over)
	w, h := b.Dx(), b.Dy()
	mask := make([]uint8, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			l, _ := luma(flat.At(b.Min.X+x, b.Min.Y+y))
			mask[y*w+x] = l
		}
	}
	mask, w, h, scaled := downscale(mask, w, h, MaxTipSide)
	if scaled && n != nil {
		n.add("Large grain images were scaled down to %d px.", MaxTipSide)
	}
	return EncodeGrain(mask, w, h)
}
