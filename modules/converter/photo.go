package converter

import (
	"context"
	"fmt"
	"image"
	_ "image/jpeg" // decoders for re-orienting photos
	"image/png"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/imaging"
)

// readablePhoto returns a file FFmpeg reads upright: HEIC through the shared
// converter (core/heic), and photos with an EXIF orientation re-encoded
// upright as a PNG in the job's TempDir. Anything else is returned as is.
func readablePhoto(ctx context.Context, job *core.JobContext, input string) (string, error) {
	if imaging.IsHEIC(input) {
		job.Progress(core.IndeterminateProgress, "Reading the HEIC photo…")
		return imaging.ToReadable(ctx, input)
	}
	o := imaging.Orientation(input)
	if o <= 1 {
		return input, nil
	}
	f, err := os.Open(input)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", input, err)
	}
	img, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		return input, nil // let FFmpeg try (and report) the original
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return "", fmt.Errorf("create temp dir: %w", err)
	}
	out := filepath.Join(job.TempDir, "upright.png")
	w, err := os.Create(out)
	if err != nil {
		return "", fmt.Errorf("create %s: %w", out, err)
	}
	if err := png.Encode(w, imaging.Orient(img, o)); err != nil {
		w.Close()
		return "", fmt.Errorf("encode upright photo: %w", err)
	}
	if err := w.Close(); err != nil {
		return "", fmt.Errorf("write upright photo: %w", err)
	}
	return out, nil
}
