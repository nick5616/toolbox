package compress

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"path/filepath"

	"golang.org/x/image/draw"

	"toolbox/core"
)

// Photo search constants (docs/specs/phase-17.md §4.3).
const (
	photoQMin      = 40  // lowest quality ever tried
	photoQMax      = 92  // highest quality tried
	photoFloorLong = 160 // below this long side a photo is "impossible"
	photoRounds    = 4   // scaled rounds after the full-size one
)

// imgFormat is the format a photo is written in.
type imgFormat int

const (
	fmtJPEG imgFormat = iota
	fmtWebP
	fmtPNG
)

func (f imgFormat) name() string {
	switch f {
	case fmtWebP:
		return "WebP"
	case fmtPNG:
		return "PNG"
	}
	return "JPEG"
}

func (f imgFormat) ext() string {
	switch f {
	case fmtWebP:
		return ".webp"
	case fmtPNG:
		return ".png"
	}
	return ".jpg"
}

// lossy reports whether the format has a quality dial.
func (f imgFormat) lossy() bool { return f != fmtPNG }

// pickFormat chooses the output format. ext is the input's extension
// (lower case). Auto and Keep fall back as documented in the spec: opaque
// photos become JPEG, transparent ones WebP (FFmpeg) or PNG without FFmpeg;
// Keep keeps JPEG/PNG/WebP and sends everything else through the auto rule.
func pickFormat(opt ImageFormat, ext string, alpha, haveFFmpeg bool) imgFormat {
	switch opt {
	case ImageJPEG:
		return fmtJPEG
	case ImageWebP:
		return fmtWebP
	case ImageKeep:
		switch ext {
		case ".jpg", ".jpeg":
			return fmtJPEG
		case ".png":
			return fmtPNG
		case ".webp":
			if haveFFmpeg {
				return fmtWebP
			}
		}
	}
	if !alpha {
		return fmtJPEG
	}
	if haveFFmpeg {
		return fmtWebP
	}
	return fmtPNG
}

// searchQuality finds the highest quality in [lo, hi] whose size is within
// budget, assuming size grows with quality. It returns the quality, its size,
// the size at lo (for rescaling) and whether anything fits.
func searchQuality(lo, hi int, budget int64, sizeAt func(q int) (int64, error)) (best int, bestSize, loSize int64, ok bool, err error) {
	loSize, err = sizeAt(lo)
	if err != nil {
		return 0, 0, 0, false, err
	}
	if loSize > budget {
		return lo, loSize, loSize, false, nil
	}
	best, bestSize = lo, loSize
	l, h := lo+1, hi
	for l <= h {
		mid := (l + h) / 2
		s, err := sizeAt(mid)
		if err != nil {
			return 0, 0, 0, false, err
		}
		if s <= budget {
			best, bestSize = mid, s
			l = mid + 1
		} else {
			h = mid - 1
		}
	}
	return best, bestSize, loSize, true, nil
}

// nextScale is the next scale factor (relative to the original) after a
// round at scale cur whose smallest result was size bytes against budget.
func nextScale(cur float64, size, budget int64) float64 {
	f := math.Sqrt(float64(budget)/float64(size)) * 0.95
	if f > 0.95 {
		f = 0.95
	}
	return cur * f
}

// encodeFn encodes img at quality q. data may be nil for estimates (size is
// then the predicted size).
type encodeFn func(img image.Image, q int) (size int64, data []byte, err error)

// fitResult is the outcome of fitImage.
type fitResult struct {
	OK       bool
	Quality  int
	Scale    float64
	W, H     int // output size in (virtual) pixels
	Size     int64
	Data     []byte
	Rounds   int
	OrigLong int
}

// scaledDims are the dimensions at scale s (at least 1 px each).
func scaledDims(w, h int, s float64) (int, int) {
	return max(1, int(math.Round(float64(w)*s))), max(1, int(math.Round(float64(h)*s)))
}

// fitImage finds the best quality (and, if needed, the gentlest scale) that
// fits budget. dimMult says each pixel of src stands for dimMult real pixels
// (used by estimates on a reduced copy).
func fitImage(ctx context.Context, src image.Image, enc encodeFn, lossy bool, budget int64, dimMult int) (fitResult, error) {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	origLong := max(sw, sh) * dimMult
	lo, hi := photoQMin, photoQMax
	if !lossy {
		lo, hi = 100, 100
	}
	scale := 1.0
	var last fitResult
	for round := 0; round <= photoRounds; round++ {
		if err := ctx.Err(); err != nil {
			return fitResult{}, err
		}
		w, h := scaledDims(sw, sh, scale)
		img := src
		if scale < 1 {
			img = resizeTo(src, w, h)
		}
		datas := map[int][]byte{}
		q, size, loSize, ok, err := searchQuality(lo, hi, budget, func(q int) (int64, error) {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			s, data, err := enc(img, q)
			if err != nil {
				return 0, err
			}
			datas[q] = data
			return s, nil
		})
		if err != nil {
			return fitResult{}, err
		}
		last = fitResult{OK: ok, Quality: q, Scale: scale, W: w * dimMult, H: h * dimMult, Size: size, Data: datas[q], Rounds: round + 1, OrigLong: origLong}
		if ok {
			return last, nil
		}
		last.Size = loSize
		if max(w, h)*dimMult <= photoFloorLong {
			return last, nil
		}
		next := nextScale(scale, loSize, budget)
		if floor := float64(photoFloorLong) / float64(origLong); next < floor {
			next = floor
		}
		if nw, nh := scaledDims(sw, sh, next); nw == w && nh == h {
			return last, nil
		}
		scale = next
	}
	return last, nil
}

// imageGrade grades a photo: quality at full size, capped at "fair" when the
// long side was cut below half.
func imageGrade(quality int, scale float64) Grade {
	g := GradePoor
	switch {
	case quality >= 80:
		g = GradeGreat
	case quality >= 65:
		g = GradeGood
	case quality >= 50:
		g = GradeFair
	}
	if scale < 0.5 && (g == GradeGreat || g == GradeGood) {
		g = GradeFair
	}
	return g
}

// imagePlan describes what happens: "JPEG quality 78 · 4032×3024" or
// "JPEG quality 60 · 4032 → 2016 px".
func imagePlan(f imgFormat, r fitResult) string {
	dims := fmt.Sprintf("%d×%d", r.W, r.H)
	if long := max(r.W, r.H); long < r.OrigLong {
		dims = fmt.Sprintf("%d → %d px", r.OrigLong, long)
	}
	if !f.lossy() {
		return fmt.Sprintf("%s · %s", f.name(), dims)
	}
	return fmt.Sprintf("%s quality %d · %s", f.name(), r.Quality, dims)
}

// ---- pixels ----

// resizeTo scales img to w × h (Catmull-Rom).
func resizeTo(img image.Image, w, h int) image.Image {
	if hasAlpha(img) {
		dst := image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Over, nil)
		return dst
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Src, nil)
	return dst
}

// hasAlpha reports whether img has any transparent pixel.
func hasAlpha(img image.Image) bool {
	if o, ok := img.(interface{ Opaque() bool }); ok {
		return !o.Opaque()
	}
	return false
}

// flatten draws img over white (JPEG has no alpha).
func flatten(img image.Image) image.Image {
	if !hasAlpha(img) {
		return img
	}
	b := img.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Over)
	return dst
}

// ---- encoders ----

func jpegEncoder() encodeFn {
	return func(img image.Image, q int) (int64, []byte, error) {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
			return 0, nil, fmt.Errorf("encode jpeg: %w", err)
		}
		return int64(buf.Len()), buf.Bytes(), nil
	}
}

func pngEncoder() encodeFn {
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	return func(img image.Image, _ int) (int64, []byte, error) {
		var buf bytes.Buffer
		if err := enc.Encode(&buf, img); err != nil {
			return 0, nil, fmt.Errorf("encode png: %w", err)
		}
		return int64(buf.Len()), buf.Bytes(), nil
	}
}

// webpGuess predicts WebP sizes as JPEG sizes x 0.75 (estimates only).
func webpGuess() encodeFn {
	j := jpegEncoder()
	return func(img image.Image, q int) (int64, []byte, error) {
		s, _, err := j(flatten(img), q)
		return s * 3 / 4, nil, err
	}
}

// webpEncoder encodes through FFmpeg's libwebp in dir (the job's TempDir).
func webpEncoder(ctx context.Context, ffmpeg, dir string) encodeFn {
	var lastImg image.Image
	const srcName, outName = "photo-src.png", "photo-out.webp"
	return func(img image.Image, q int) (int64, []byte, error) {
		if lastImg != img {
			f, err := os.Create(filepath.Join(dir, srcName))
			if err != nil {
				return 0, nil, fmt.Errorf("create temp png: %w", err)
			}
			err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(f, img)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return 0, nil, fmt.Errorf("write temp png: %w", err)
			}
			lastImg = img
		}
		args := append(commonArgs(), "-i", srcName, "-c:v", "libwebp", "-quality", fmt.Sprint(q), "-compression_level", "4", outName)
		if err := runFF(ctx, nil, ffmpeg, dir, args, 0, "WebP"); err != nil {
			return 0, nil, err
		}
		data, err := os.ReadFile(filepath.Join(dir, outName))
		if err != nil {
			return 0, nil, fmt.Errorf("read webp: %w", err)
		}
		return int64(len(data)), data, nil
	}
}

// photoError is the user-facing error for a photo that can't be read.
func photoError(path string, err error) error {
	if ae := core.AsAppError(err); ae != nil && ae.Code == core.CodeDependencyMissing {
		return core.Errorf(core.CodeToolFailed, "Can't read this photo (HEIC needs the AI engine)").
			WithHint(ae.Hint).WithCause(err)
	}
	return core.Errorf(core.CodeToolFailed, "Can't read this photo").WithCause(fmt.Errorf("%s: %w", filepath.Base(path), err))
}
