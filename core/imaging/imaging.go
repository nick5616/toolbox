// Package imaging reads image sizes and builds scaled previews (data URLs)
// with pure-Go decoders: jpeg, png, gif, webp, bmp, tiff. HEIC/HEIF can't be
// decoded in Go; callers get a validation error and show a file-type tile.
package imaging

import (
	"bytes"
	"container/list"
	"encoding/base64"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	"golang.org/x/image/tiff"
	"golang.org/x/image/webp"

	"toolbox/core"
)

// Limits (SPEC §3.4).
const (
	MaxFileBytes = 400 << 20
	MaxPixels    = 300_000_000
	MinThumbDim  = 64
	MaxThumbDim  = 1600
	cacheEntries = 64
	workers      = 2
	// Above this many source pixels, scale with bilinear (CatmullRom is slow).
	fastScalePixels = 40_000_000
)

var decoders = map[string]struct {
	decode func(r *bytes.Reader) (image.Image, error)
	config func(r *bytes.Reader) (image.Config, error)
}{
	".jpg":  {func(r *bytes.Reader) (image.Image, error) { return jpeg.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return jpeg.DecodeConfig(r) }},
	".jpeg": {func(r *bytes.Reader) (image.Image, error) { return jpeg.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return jpeg.DecodeConfig(r) }},
	".png":  {func(r *bytes.Reader) (image.Image, error) { return png.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return png.DecodeConfig(r) }},
	".gif":  {func(r *bytes.Reader) (image.Image, error) { return gif.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return gif.DecodeConfig(r) }},
	".webp": {func(r *bytes.Reader) (image.Image, error) { return webp.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return webp.DecodeConfig(r) }},
	".bmp":  {func(r *bytes.Reader) (image.Image, error) { return bmp.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return bmp.DecodeConfig(r) }},
	".tif":  {func(r *bytes.Reader) (image.Image, error) { return tiff.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return tiff.DecodeConfig(r) }},
	".tiff": {func(r *bytes.Reader) (image.Image, error) { return tiff.Decode(r) }, func(r *bytes.Reader) (image.Config, error) { return tiff.DecodeConfig(r) }},
}

// IsHEIC reports whether path has a HEIC/HEIF extension.
func IsHEIC(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".heic" || ext == ".heif"
}

// Supported reports whether path's extension can be decoded here.
func Supported(path string) bool {
	_, ok := decoders[strings.ToLower(filepath.Ext(path))]
	return ok
}

func checkPath(path string) (os.FileInfo, error) {
	if IsHEIC(path) {
		return nil, core.Errorf(core.CodeValidation, "No preview for HEIC")
	}
	if !Supported(path) || !filepath.IsAbs(path) {
		return nil, core.Errorf(core.CodeValidation, "No preview for this file type")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path))
	}
	if info.Size() > MaxFileBytes {
		return nil, core.Errorf(core.CodeValidation, "Too large to preview")
	}
	return info, nil
}

// Size returns an image's pixel dimensions without decoding the pixels.
func Size(path string) (core.Size, error) {
	if _, err := checkPath(path); err != nil {
		return core.Size{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return core.Size{}, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	// Headers are small; read at most 1 MiB for DecodeConfig.
	head := make([]byte, 1<<20)
	n, err := f.Read(head)
	if err != nil && n == 0 {
		return core.Size{}, core.Errorf(core.CodeValidation, "Couldn't read this image")
	}
	cfg, err := decoders[strings.ToLower(filepath.Ext(path))].config(bytes.NewReader(head[:n]))
	if err != nil {
		return core.Size{}, core.Errorf(core.CodeValidation, "Couldn't read this image")
	}
	return core.Size{W: cfg.Width, H: cfg.Height}, nil
}

// Thumbnailer builds cached, size-bounded previews on a small worker pool.
type Thumbnailer struct {
	sem   chan struct{}
	mu    sync.Mutex
	lru   *list.List // of *cacheEntry, front = most recent
	index map[string]*list.Element
}

type cacheEntry struct {
	key, url string
}

// NewThumbnailer builds a Thumbnailer.
func NewThumbnailer() *Thumbnailer {
	return &Thumbnailer{sem: make(chan struct{}, workers), lru: list.New(), index: map[string]*list.Element{}}
}

var (
	defaultOnce sync.Once
	defaultT    *Thumbnailer
)

// Default is the process-wide Thumbnailer.
func Default() *Thumbnailer {
	defaultOnce.Do(func() { defaultT = NewThumbnailer() })
	return defaultT
}

// Thumb returns path as a data URL scaled so its longest side is ≤ maxDim
// (clamped to 64..1600). PNG when any pixel is non-opaque, else JPEG q85.
func (t *Thumbnailer) Thumb(path string, maxDim int) (string, error) {
	maxDim = min(max(maxDim, MinThumbDim), MaxThumbDim)
	info, err := checkPath(path)
	if err != nil {
		return "", err
	}
	key := fmt.Sprintf("%s|%d|%d|%d", path, info.Size(), info.ModTime().UnixNano(), maxDim)
	if url, ok := t.get(key); ok {
		return url, nil
	}
	t.sem <- struct{}{}
	defer func() { <-t.sem }()
	if url, ok := t.get(key); ok { // another worker may have built it meanwhile
		return url, nil
	}
	url, err := build(path, maxDim)
	if err != nil {
		return "", err
	}
	t.put(key, url)
	return url, nil
}

func (t *Thumbnailer) get(key string) (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if el, ok := t.index[key]; ok {
		t.lru.MoveToFront(el)
		return el.Value.(*cacheEntry).url, true
	}
	return "", false
}

func (t *Thumbnailer) put(key, url string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if el, ok := t.index[key]; ok {
		t.lru.MoveToFront(el)
		return
	}
	t.index[key] = t.lru.PushFront(&cacheEntry{key: key, url: url})
	for t.lru.Len() > cacheEntries {
		old := t.lru.Back()
		t.lru.Remove(old)
		delete(t.index, old.Value.(*cacheEntry).key)
	}
}

func build(path string, maxDim int) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	dec := decoders[strings.ToLower(filepath.Ext(path))]
	cfg, err := dec.config(bytes.NewReader(b))
	if err != nil {
		return "", core.Errorf(core.CodeValidation, "Couldn't read this image")
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxPixels {
		return "", core.Errorf(core.CodeValidation, "Too large to preview")
	}
	src, err := dec.decode(bytes.NewReader(b))
	if err != nil {
		return "", core.Errorf(core.CodeValidation, "Couldn't read this image")
	}
	dst := scale(src, maxDim)
	var buf bytes.Buffer
	if dst.Opaque() {
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 85}); err != nil {
			return "", fmt.Errorf("encode preview: %w", err)
		}
		return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
	}
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, dst); err != nil {
		return "", fmt.Errorf("encode preview: %w", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// scale returns src fitted into maxDim×maxDim (never upscaled) as NRGBA.
func scale(src image.Image, maxDim int) *image.NRGBA {
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
	var s draw.Scaler = draw.CatmullRom
	if b.Dx()*b.Dy() > fastScalePixels {
		s = draw.ApproxBiLinear
	}
	if w == b.Dx() && h == b.Dy() {
		draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
	} else {
		s.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	}
	return dst
}
