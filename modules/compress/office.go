package compress

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/imaging"
)

// officeLevel is one rung of the Office ladder: the longest side pictures
// may have and the JPEG quality.
type officeLevel struct{ Long, Quality int }

// officeLadder goes from the gentlest to the hardest level.
var officeLadder = []officeLevel{{2400, 85}, {1920, 80}, {1600, 75}, {1280, 70}, {1024, 60}, {800, 50}}

// maxPictureBytes skips absurdly large embedded pictures.
const maxPictureBytes = 100 << 20

func officePlan(l officeLevel, pictures int) string {
	noun := "pictures"
	if pictures == 1 {
		noun = "picture"
	}
	return fmt.Sprintf("%d %s at ≤ %d px, quality %d", pictures, noun, l.Long, l.Quality)
}

// isOfficePicture reports whether a zip entry is a JPEG/PNG under */media/.
func isOfficePicture(name string) bool {
	n := strings.ToLower(name)
	if !strings.HasPrefix(n, "word/media/") && !strings.HasPrefix(n, "ppt/media/") && !strings.HasPrefix(n, "xl/media/") {
		return false
	}
	switch filepath.Ext(n) {
	case ".jpg", ".jpeg", ".png":
		return true
	}
	return false
}

// shrinkPicture re-encodes one embedded picture at lvl: JPEG at the level's
// quality and long side, PNG only downscaled (best deflate). It returns the
// original data when the result isn't smaller or the picture can't be
// handled (unknown format, EXIF-rotated JPEG whose orientation Office
// applies itself).
func shrinkPicture(data []byte, lvl officeLevel, tmpDir string) ([]byte, bool) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png") {
		return data, false
	}
	if format == "jpeg" && bytes.Contains(data[:min(len(data), 1<<16)], []byte("Exif")) {
		tmp := filepath.Join(tmpDir, "office-exif.jpg")
		if os.WriteFile(tmp, data, 0o644) != nil {
			return data, false
		}
		o := imaging.Orientation(tmp)
		_ = os.Remove(tmp)
		if o != 1 {
			return data, false
		}
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data, false
	}
	if long := max(cfg.Width, cfg.Height); long > lvl.Long {
		w, h := scaledDims(cfg.Width, cfg.Height, float64(lvl.Long)/float64(long))
		img = resizeTo(img, w, h)
	}
	var buf bytes.Buffer
	switch format {
	case "jpeg":
		err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: lvl.Quality})
	default:
		err = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, img)
	}
	if err != nil || buf.Len() >= len(data) {
		return data, false
	}
	return buf.Bytes(), true
}

// rewriteOffice writes src to dst with its pictures recompressed at lvl and
// every other entry copied byte for byte, in the original order. It returns
// how many pictures got smaller.
func rewriteOffice(ctx context.Context, src, dst string, lvl officeLevel, tmpDir string) (int, error) {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return 0, core.Errorf(core.CodeToolFailed, "Can't read this Office file").WithCause(err)
	}
	defer zr.Close()
	out, err := os.Create(dst)
	if err != nil {
		return 0, fmt.Errorf("create %s: %w", dst, err)
	}
	zw := zip.NewWriter(out)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, flate.BestCompression)
	})
	shrunk := 0
	fail := func(err error) (int, error) {
		out.Close()
		_ = os.Remove(dst)
		return 0, err
	}
	for _, f := range zr.File {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		if isOfficePicture(f.Name) && f.UncompressedSize64 <= maxPictureBytes {
			rc, err := f.Open()
			if err != nil {
				return fail(fmt.Errorf("open %s: %w", f.Name, err))
			}
			data, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return fail(fmt.Errorf("read %s: %w", f.Name, err))
			}
			if nd, ok := shrinkPicture(data, lvl, tmpDir); ok {
				hdr := &zip.FileHeader{Name: f.Name, Method: zip.Deflate, Modified: f.Modified}
				w, err := zw.CreateHeader(hdr)
				if err != nil {
					return fail(fmt.Errorf("write %s: %w", f.Name, err))
				}
				if _, err := w.Write(nd); err != nil {
					return fail(fmt.Errorf("write %s: %w", f.Name, err))
				}
				shrunk++
				continue
			}
		}
		hdr := f.FileHeader
		w, err := zw.CreateRaw(&hdr)
		if err != nil {
			return fail(fmt.Errorf("copy %s: %w", f.Name, err))
		}
		raw, err := f.OpenRaw()
		if err != nil {
			return fail(fmt.Errorf("open %s: %w", f.Name, err))
		}
		if _, err := io.Copy(w, raw); err != nil {
			return fail(fmt.Errorf("copy %s: %w", f.Name, err))
		}
	}
	if err := zw.Close(); err != nil {
		return fail(fmt.Errorf("finish zip: %w", err))
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return 0, fmt.Errorf("close %s: %w", dst, err)
	}
	return shrunk, nil
}

// runOffice walks the ladder (binary search) for the gentlest level that fits.
func runOffice(ctx context.Context, job *core.JobContext, in input) (Result, error) {
	budget := Budget(in.Limit)
	steps := 1
	for n := len(officeLadder); n > 1; n /= 2 {
		steps++
	}
	attempts := 0
	smallest := int64(1<<63 - 1)
	paths := map[int]string{}
	counts := map[int]int{}
	idx, err := searchLadder(len(officeLadder), func(i int) (bool, error) {
		job.Progress(float64(attempts)/float64(steps+1), "Shrinking the pictures…")
		out := filepath.Join(job.TempDir, fmt.Sprintf("office-%d.zip", i))
		n, err := rewriteOffice(ctx, in.Path, out, officeLadder[i], job.TempDir)
		attempts++
		if err != nil {
			return false, err
		}
		size, err := fileSize(out)
		if err != nil {
			return false, err
		}
		smallest = min(smallest, size)
		if size <= budget {
			paths[i], counts[i] = out, n
			return true, nil
		}
		_ = os.Remove(out)
		return false, nil
	})
	if err != nil {
		return Result{}, err
	}
	if idx < 0 {
		return Result{}, overLimit(smallest, in.Limit, "The text and layout alone are close to the limit, so shrinking the pictures isn't enough")
	}
	out, err := saveOutput(job, paths[idx], OutputName(in.Path), strings.ToLower(filepath.Ext(in.Path)))
	if err != nil {
		return Result{}, err
	}
	return Result{Outputs: []string{out}, Plan: officePlan(officeLadder[idx], counts[idx]), Grade: ladderGrade(idx), Attempts: attempts}, nil
}

// estimateOffice opens the zip: if the parts that can't shrink are already
// over the budget it's impossible, else it's possible.
func estimateOffice(ctx context.Context, tool toolFunc, in input) Estimate {
	zr, err := zip.OpenReader(in.Path)
	if err != nil {
		return Estimate{Problem: "Can't read this Office file"}
	}
	defer zr.Close()
	var fixed int64
	pictures := 0
	for _, f := range zr.File {
		if isOfficePicture(f.Name) {
			pictures++
			continue
		}
		fixed += int64(f.CompressedSize64) + 100 // headers
	}
	if fixed > Budget(in.Limit) {
		return Estimate{Plan: "Can't fit", Note: "The text and layout alone are over the limit"}
	}
	noun := "pictures"
	if pictures == 1 {
		noun = "picture"
	}
	return Estimate{Possible: true, Plan: fmt.Sprintf("Shrinks %d %s", pictures, noun)}
}
