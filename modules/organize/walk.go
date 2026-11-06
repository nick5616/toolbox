package organize

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"toolbox/core"
)

// junk are file names that are never worth copying.
var junk = map[string]bool{"thumbs.db": true, "desktop.ini": true, ".ds_store": true, "ehthumbs.db": true}

// skipName reports whether a file or folder name is hidden or system clutter.
func skipName(name string) bool {
	return strings.HasPrefix(name, ".") || junk[strings.ToLower(name)]
}

// pathKey normalises a path for comparisons (case-insensitive on Windows and macOS).
func pathKey(p string) string {
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p = strings.ToLower(p)
	}
	return p
}

// expandInputs turns files and folders into a sorted, de-duplicated list of
// regular files. Folders are walked recursively; hidden and system files and
// folders are ignored; symlinked folders are not followed. A file named
// directly is kept even if hidden.
func expandInputs(ctx context.Context, inputs []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	add := func(p string) error {
		k := pathKey(p)
		if seen[k] {
			return nil
		}
		seen[k] = true
		out = append(out, p)
		if len(out) > MaxFiles {
			return core.ValidationError(fmt.Sprintf("That's more than %d files. Organize a smaller folder at a time", MaxFiles), nil)
		}
		return nil
	}
	for _, in := range inputs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		st, err := os.Stat(in)
		if err != nil {
			return nil, core.ValidationError("File or folder not found: "+filepath.Base(in), nil).WithCause(err)
		}
		if !st.IsDir() {
			if st.Mode().IsRegular() {
				if err := add(filepath.Clean(in)); err != nil {
					return nil, err
				}
			}
			continue
		}
		err = filepath.WalkDir(in, func(p string, d fs.DirEntry, werr error) error {
			if werr != nil {
				if p == in {
					return werr
				}
				return nil // unreadable entries are skipped
			}
			if cerr := ctx.Err(); cerr != nil {
				return cerr
			}
			if p == in {
				return nil
			}
			if skipName(d.Name()) || systemEntry(p, d) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			return add(filepath.Clean(p))
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(out, func(i, j int) bool { return pathKey(out[i]) < pathKey(out[j]) })
	return out, nil
}

// within reports whether child is inside parent (not equal).
func within(parent, child string) bool {
	p, c := pathKey(parent), pathKey(child)
	if p == c {
		return false
	}
	sep := string(filepath.Separator)
	if !strings.HasSuffix(p, sep) {
		p += sep
	}
	return strings.HasPrefix(c, p)
}

// related is true when a and b are the same path or one contains the other.
func related(a, b string) bool {
	return pathKey(a) == pathKey(b) || within(a, b) || within(b, a)
}

// resolved is p made absolute with symlinks resolved as far as they exist.
func resolved(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	// Resolve the deepest existing ancestor, then re-append the rest.
	rest := ""
	cur := abs
	for {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return abs
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// checkRoot refuses a destination that is inside, above or equal to any input.
func checkRoot(root string, inputs []string) error {
	r := resolved(root)
	for _, in := range inputs {
		if related(r, resolved(in)) {
			return core.ValidationError("The destination can't be inside or above the files you're organizing", map[string]string{"destination": "Choose a folder that is separate from the files you're organizing"}).
				WithHint("Pick another folder, or leave this empty to use the library.")
		}
	}
	return nil
}
