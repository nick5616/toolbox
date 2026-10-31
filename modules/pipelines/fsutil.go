package pipelines

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// Limits for names (SPEC.md §7.1).
const maxNameRunes = 150

// cleanName makes s safe as a file or folder name on Windows and macOS:
// illegal characters and control characters become "-", whitespace is
// collapsed, the result is trimmed to 150 characters and has no trailing
// dots or spaces. It may return "".
func cleanName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f, strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if r := []rune(out); len(r) > maxNameRunes {
		out = string(r[:maxNameRunes])
	}
	return strings.TrimRight(out, " .")
}

// reserve picks a path in dir that doesn't exist and creates it empty, so
// concurrent jobs can't pick the same name.
func reserve(dir, stem, ext string) (string, error) {
	for range 1000 {
		p := core.UniquePath(dir, stem, ext)
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			_ = f.Close()
			return p, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", fmt.Errorf("creating %s: %w", filepath.Base(p), err)
		}
	}
	return "", fmt.Errorf("no free name for %s%s in %s", stem, ext, dir)
}

// ctxReader fails reads once ctx is cancelled so large copies stop promptly.
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

// copyInto copies src over the (already reserved) dst. dst is removed on error.
func copyInto(ctx context.Context, src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("opening %s: %w", filepath.Base(src), err)
	}
	defer in.Close()
	if st, serr := in.Stat(); serr == nil && st.IsDir() {
		return core.ValidationError(filepath.Base(src)+" is a folder, not a file", nil)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_TRUNC|os.O_CREATE, 0o644)
	if err != nil {
		return fmt.Errorf("writing %s: %w", filepath.Base(dst), err)
	}
	defer func() {
		if cerr := out.Close(); err == nil && cerr != nil {
			err = fmt.Errorf("writing %s: %w", filepath.Base(dst), cerr)
		}
		if err != nil {
			_ = os.Remove(dst)
		}
	}()
	if _, err = io.Copy(out, ctxReader{ctx, in}); err != nil {
		return fmt.Errorf("copying %s: %w", filepath.Base(src), err)
	}
	return nil
}

// isInside reports whether path is root or below it (symlinks resolved when
// possible, case-insensitive on Windows via filepath.Rel).
func isInside(path, root string) bool {
	if root == "" || path == "" {
		return false
	}
	a, err1 := filepath.Abs(path)
	b, err2 := filepath.Abs(root)
	if err1 != nil || err2 != nil {
		return false
	}
	if r, err := filepath.EvalSymlinks(a); err == nil {
		a = r
	}
	if r, err := filepath.EvalSymlinks(b); err == nil {
		b = r
	}
	rel, err := filepath.Rel(b, a)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// subfolderPath joins the cleaned segments of an expanded subfolder template
// under base ("." and ".." segments are dropped).
func subfolderPath(base, sub string) string {
	for _, seg := range strings.FieldsFunc(sub, func(r rune) bool { return r == '/' || r == '\\' }) {
		seg = cleanName(seg)
		if seg == "" || seg == "." || seg == ".." {
			continue
		}
		base = filepath.Join(base, seg)
	}
	return base
}
