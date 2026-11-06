package compress

import (
	"context"
	"fmt"
	"image"
	_ "image/gif" // decoders for the photo inputs
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"toolbox/core"
	"toolbox/core/imaging"
)

// estimateMaxPixels is the size above which estimates search a half-size copy.
const estimateMaxPixels = 40_000_000

// loadPhoto decodes a photo upright (HEIC through the registered converter,
// EXIF orientation applied for the rest).
func loadPhoto(ctx context.Context, path string) (image.Image, error) {
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return nil, photoError(path, err)
	}
	f, err := os.Open(readable)
	if err != nil {
		return nil, photoError(path, err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, photoError(path, err)
	}
	if readable == path { // converted HEIC is already upright
		img = imaging.Orient(img, imaging.Orientation(path))
	}
	return img, nil
}

// ffmpegPath resolves FFmpeg, "" when it isn't available.
func ffmpegPath(tool toolFunc) string {
	if tool == nil {
		return ""
	}
	p, err := tool("ffmpeg")
	if err != nil {
		return ""
	}
	return p
}

// runImage re-encodes a photo at the best quality that fits (shrinking it
// only if needed). Metadata (location, camera) is always dropped by the
// re-encode, so Options.KeepMetadata does not apply to photos.
func runImage(ctx context.Context, job *core.JobContext, in input) (Result, error) {
	job.Progress(core.IndeterminateProgress, "Reading the photo…")
	img, err := loadPhoto(ctx, in.Path)
	if err != nil {
		return Result{}, err
	}
	ffmpeg := ffmpegPath(job.Tool)
	f := pickFormat(in.Opts.ImageFormat, strings.ToLower(filepath.Ext(in.Path)), hasAlpha(img), ffmpeg != "")
	if f == fmtWebP && ffmpeg == "" {
		_, err := job.Tool("ffmpeg")
		if err == nil {
			err = core.ErrDependencyMissing("ffmpeg", "Install the Media pack in Settings → Tool packs")
		}
		return Result{}, err
	}
	var enc encodeFn
	switch f {
	case fmtJPEG:
		img = flatten(img)
		enc = jpegEncoder()
	case fmtPNG:
		enc = pngEncoder()
	case fmtWebP:
		enc = webpEncoder(ctx, ffmpeg, job.TempDir)
	}
	job.Progress(core.IndeterminateProgress, "Finding the best quality that fits…")
	r, err := fitImage(ctx, img, enc, f.lossy(), Budget(in.Limit), 1)
	if err != nil {
		return Result{}, err
	}
	if !r.OK {
		return Result{}, overLimit(r.Size, in.Limit, "This photo is too detailed to get that small without making it tiny")
	}
	tmp := filepath.Join(job.TempDir, "photo-final"+f.ext())
	if err := os.WriteFile(tmp, r.Data, 0o644); err != nil {
		return Result{}, fmt.Errorf("write %s: %w", tmp, err)
	}
	out, err := saveOutput(job, tmp, OutputName(in.Path), f.ext())
	if err != nil {
		return Result{}, err
	}
	return Result{Outputs: []string{out}, Plan: imagePlan(f, r), Grade: imageGrade(r.Quality, r.Scale), Attempts: r.Rounds}, nil
}

// estimateImage runs the same search in memory, nothing written.
func estimateImage(ctx context.Context, tool toolFunc, in input) Estimate {
	img, err := loadPhoto(ctx, in.Path)
	if err != nil {
		return Estimate{Problem: problemText(err)}
	}
	haveFF := ffmpegPath(tool) != ""
	f := pickFormat(in.Opts.ImageFormat, strings.ToLower(filepath.Ext(in.Path)), hasAlpha(img), haveFF)
	est := Estimate{}
	var enc encodeFn
	switch f {
	case fmtJPEG:
		img = flatten(img)
		enc = jpegEncoder()
	case fmtPNG:
		enc = pngEncoder()
		if in.Opts.ImageFormat == ImageAuto && hasAlpha(img) && !haveFF {
			est.Note = "Without FFmpeg a transparent photo stays PNG and is only shrunk"
		}
	case fmtWebP:
		if !haveFF {
			est.Problem = "Needs FFmpeg: install the Media pack"
			return est
		}
		enc = webpGuess()
	}
	mult := 1
	if b := img.Bounds(); b.Dx()*b.Dy() > estimateMaxPixels {
		img = resizeTo(img, max(1, b.Dx()/2), max(1, b.Dy()/2))
		mult = 2
		inner := enc
		enc = func(i image.Image, q int) (int64, []byte, error) { // 4x the pixels, about 4x the bytes
			s, d, err := inner(i, q)
			return s * 4, d, err
		}
	}
	r, err := fitImage(ctx, img, enc, f.lossy(), Budget(in.Limit), mult)
	if err != nil {
		est.Problem = problemText(err)
		return est
	}
	est.Possible = r.OK
	est.Plan = imagePlan(f, r)
	if r.OK {
		est.Grade = imageGrade(r.Quality, r.Scale)
	} else {
		est.Plan = "Can't fit"
		est.Note = "Too detailed to get that small without making it tiny"
	}
	return est
}

// problemText is the one-line reason an estimate failed.
func problemText(err error) string {
	if ae := core.AsAppError(err); ae != nil && ae.Code != core.CodeInternal {
		return ae.Message
	}
	return "Can't read this file"
}
