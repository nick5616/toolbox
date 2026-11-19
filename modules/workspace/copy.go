package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// srcFile is one baseline file the seed or restore may copy.
type srcFile struct {
	Rel     string // "/" separators
	Abs     string
	Size    int64
	ModTime time.Time
}

// walkBaseline lists the baseline's regular files, skipping hidden entries,
// links (symlinks, junctions) and anything matching an exclude glob. Folders
// that match are skipped whole. Nothing in the baseline is written.
func walkBaseline(ctx context.Context, root string, exclude []string) ([]srcFile, error) {
	var out []srcFile
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == root {
				return err
			}
			return nil // unreadable entry: leave it out
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if p == root {
			return nil
		}
		if skipEntry(p, d) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if matchesAny(exclude, rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, srcFile{Rel: rel, Abs: p, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Rel < out[j].Rel })
	return out, nil
}

// matchesAny reports whether rel matches any glob (path.Match, "/" separators,
// case-insensitive).
func matchesAny(globs []string, rel string) bool {
	rel = strings.ToLower(rel)
	for _, g := range globs {
		g = strings.ToLower(strings.TrimSpace(filepath.ToSlash(g)))
		if g == "" {
			continue
		}
		if ok, _ := path.Match(g, rel); ok {
			return true
		}
	}
	return false
}

// copyResult is what copying one file produced.
type copyResult struct {
	SrcSha256 string
	Sha256    string
	Size      int64
	Stripped  bool // location data was removed from the copy
}

// ctxReader stops a copy when ctx is cancelled.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// copyFile copies src to dst through a temp file next to dst: it hashes the
// source while copying, sets the source's modification time, runs strip (when
// not nil) on the temp file, hashes the final file and renames it into place.
// A file that can't be opened (locked) returns an error and leaves nothing.
func copyFile(ctx context.Context, src srcFile, dst string, strip func(tmp string) error) (copyResult, error) {
	var res copyResult
	in, err := os.Open(src.Abs)
	if err != nil {
		return res, err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return res, err
	}
	tmp := filepath.Join(filepath.Dir(dst), ".toolbox-copy-"+filepath.Base(dst)) // keeps the extension: ExifTool picks its writer by it
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return res, err
	}
	cleanup := func() { _ = os.Remove(tmp) }
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, h), ctxReader{ctx, in}); err != nil {
		out.Close()
		cleanup()
		return res, err
	}
	if err := out.Close(); err != nil {
		cleanup()
		return res, err
	}
	res.SrcSha256 = hex.EncodeToString(h.Sum(nil))
	if strip != nil {
		if err := strip(tmp); err != nil {
			cleanup()
			return res, &stripError{err}
		}
		res.Stripped = true
	}
	if err := os.Chtimes(tmp, src.ModTime, src.ModTime); err != nil {
		cleanup()
		return res, err
	}
	sum, size, err := hashFile(ctx, tmp)
	if err != nil {
		cleanup()
		return res, err
	}
	res.Sha256, res.Size = sum, size
	if err := os.Rename(tmp, dst); err != nil {
		cleanup()
		return res, err
	}
	return res, nil
}

// stripError marks a failure of the strip step (the file itself was readable).
type stripError struct{ err error }

func (e *stripError) Error() string { return "removing location data: " + e.err.Error() }
func (e *stripError) Unwrap() error { return e.err }

func isStripError(err error) bool {
	var se *stripError
	return errors.As(err, &se)
}

func hashFile(ctx context.Context, p string) (sum string, size int64, err error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, ctxReader{ctx, f})
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// mediaExts are the photo and video types whose copies get location data
// removed.
var mediaExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".heic": true, ".heif": true, ".tif": true, ".tiff": true,
	".mp4": true, ".mov": true, ".m4v": true, ".3gp": true, ".avi": true, ".mkv": true,
}

func isMedia(rel string) bool { return mediaExts[strings.ToLower(filepath.Ext(rel))] }

// exifStripArgs are ExifTool's arguments for removing location and the camera
// serial from a copy (the same tags as the Metadata tool's "Strip location").
func exifStripArgs(file string) []string {
	return []string{"-gps:all=", "-xmp:geotag=", "-SerialNumber=", "-overwrite_original", file}
}

// within reports whether p is inside dir, with a readable message otherwise.
func checkInside(p, dir string) error {
	rel, err := filepath.Rel(dir, p)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return fmt.Errorf("%s is outside the workspace library", filepath.Base(p))
	}
	return nil
}
