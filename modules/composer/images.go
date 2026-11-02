package composer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/sidecar"
)

// Image loading limits.
const (
	minLoadDim = 64
	// Above this many source pixels, scale with bilinear (CatmullRom is slow).
	fastScalePixels = 40_000_000
	loadJPEGQuality = 92
)

// loadSlots bounds concurrent decodes (a 4096 px decode can use ~200 MB).
var loadSlots = make(chan struct{}, 2)

func isHEIC(path string) bool { return imaging.IsHEIC(path) }

func missingEngine(err error) error {
	var ae *core.AppError
	if errors.As(err, &ae) && ae.Code == core.CodeDependencyMissing {
		return (&core.AppError{
			Code: core.CodeDependencyMissing, Message: "HEIC photos need the AI engine",
			Hint: "Install the Image pack in Settings → Tool packs",
		}).WithCause(err)
	}
	return err
}

func fileKey(parts ...any) string {
	h := sha256.New()
	for _, p := range parts {
		fmt.Fprintf(h, "%v\x00", p)
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// LoadImage returns path scaled to fit maxDim (never enlarged) with EXIF
// orientation applied, as a data URL: PNG when the picture has transparency,
// else JPEG q92. HEIC goes through the AI engine first. Results are cached
// in CacheDir by path + size + mtime + maxDim.
func (m *Module) LoadImage(ctx context.Context, path string, maxDim int) (string, error) {
	if !filepath.IsAbs(path) {
		return "", core.ValidationError("Image path must be absolute", nil)
	}
	if maxDim < minLoadDim || maxDim > MaxLoadDim {
		return "", core.ValidationError(fmt.Sprintf("Image size must be between %d and %d", minLoadDim, MaxLoadDim), nil)
	}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return "", core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path))
	}
	if fi.Size() > imaging.MaxFileBytes {
		return "", core.ValidationError("This image is too large", nil)
	}
	key := fileKey("v2", path, fi.Size(), fi.ModTime().UnixNano(), maxDim) // v2: HEIC rotation fix
	if url, ok := m.readCached(key); ok {
		return url, nil
	}

	select {
	case loadSlots <- struct{}{}:
		defer func() { <-loadSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}

	src := path
	if isHEIC(path) {
		if src, err = m.convertHEIC(ctx, path, fi.Size(), fi.ModTime().UnixNano()); err != nil {
			return "", err
		}
	} else if !imaging.Supported(path) {
		return "", core.ValidationError("This file type can't be used as a picture", nil)
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", src, err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return "", core.Errorf(core.CodeValidation, "Couldn't read this image").WithCause(err)
	}
	if int64(cfg.Width)*int64(cfg.Height) > imaging.MaxPixels {
		return "", core.ValidationError("This image is too large", nil)
	}
	img, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return "", core.Errorf(core.CodeValidation, "Couldn't read this image").WithCause(err)
	}
	out := imaging.Orient(scaleTo(img, maxDim), imaging.Orientation(src))
	data, ext, err := encodeLoaded(out)
	if err != nil {
		return "", err
	}
	m.writeCached(key, ext, data)
	return dataURL(ext, data), nil
}

func dataURL(ext string, data []byte) string {
	mime := "image/jpeg"
	if ext == ".png" {
		mime = "image/png"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func (m *Module) readCached(key string) (string, bool) {
	if m.cfg.CacheDir == "" {
		return "", false
	}
	for _, ext := range []string{".jpg", ".png"} {
		if b, err := os.ReadFile(filepath.Join(m.cfg.CacheDir, key+ext)); err == nil && len(b) > 0 {
			return dataURL(ext, b), true
		}
	}
	return "", false
}

func (m *Module) writeCached(key, ext string, data []byte) {
	if m.cfg.CacheDir == "" || os.MkdirAll(m.cfg.CacheDir, 0o755) != nil {
		return
	}
	_ = writeFileAtomic(filepath.Join(m.cfg.CacheDir, key+ext), data)
}

// convertHEIC decodes a HEIC photo into a cached PNG via the AI engine.
func (m *Module) convertHEIC(ctx context.Context, path string, size, mtime int64) (string, error) {
	if imaging.HEICAvailable() { // FFmpeg first, the engine as its fallback (core/heic)
		return imaging.ToReadable(ctx, path)
	}
	if m.cfg.Engine == nil {
		return "", core.ErrDependencyMissing(sidecar.DepID, "Install the Image pack in Settings → Tool packs")
	}
	if err := os.MkdirAll(m.cfg.CacheDir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create the image cache").WithCause(err)
	}
	out := filepath.Join(m.cfg.CacheDir, "heic-"+fileKey(path, size, mtime)+".png")
	if fi, err := os.Stat(out); err == nil && fi.Size() > 0 {
		return out, nil
	}
	tmp := strings.TrimSuffix(out, ".png") + ".tmp.png"
	defer os.Remove(tmp)
	if _, err := m.cfg.Engine.Call(ctx, "image.convert", map[string]any{"input": path, "output": tmp}, nil); err != nil {
		return "", missingEngine(err)
	}
	if fi, err := os.Stat(tmp); err != nil || fi.Size() == 0 {
		return "", core.Errorf(core.CodeToolFailed, "Couldn't read this HEIC photo")
	}
	if err := os.Rename(tmp, out); err != nil {
		return "", fmt.Errorf("store converted photo: %w", err)
	}
	return out, nil
}

// scaleTo fits src into maxDim×maxDim (never enlarged) as NRGBA.
func scaleTo(src image.Image, maxDim int) *image.NRGBA {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > maxDim || h > maxDim {
		if w >= h {
			h = max(1, h*maxDim/w)
			w = maxDim
		} else {
			w = max(1, w*maxDim/h)
			h = maxDim
		}
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	if w == b.Dx() && h == b.Dy() {
		draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
		return dst
	}
	var s draw.Scaler = draw.CatmullRom
	if b.Dx()*b.Dy() > fastScalePixels {
		s = draw.ApproxBiLinear
	}
	s.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	return dst
}

// encodeLoaded writes PNG when the picture has transparency, else JPEG.
func encodeLoaded(img image.Image) ([]byte, string, error) {
	var buf bytes.Buffer
	if o, ok := img.(interface{ Opaque() bool }); ok && !o.Opaque() {
		if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, img); err != nil {
			return nil, "", fmt.Errorf("encode image: %w", err)
		}
		return buf.Bytes(), ".png", nil
	}
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: loadJPEGQuality}); err != nil {
		return nil, "", fmt.Errorf("encode image: %w", err)
	}
	return buf.Bytes(), ".jpg", nil
}

// writeFileAtomic writes via a temp file in the same folder and renames.
func writeFileAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := f.Name()
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		os.Remove(name)
		return errors.Join(werr, cerr)
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}
