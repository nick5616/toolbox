package core

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// ValidateFileInputs checks that every input is an absolute path to an
// existing regular file whose extension is in exts (case-insensitive).
// Problems are reported per input as Fields["inputs.<i>"].
func ValidateFileInputs(inputs []string, exts []string) error {
	fields := map[string]string{}
	if len(inputs) == 0 {
		fields["inputs"] = "Add at least one file"
	}
	for i, in := range inputs {
		key := fmt.Sprintf("inputs.%d", i)
		if !filepath.IsAbs(in) {
			fields[key] = "File not found"
			continue
		}
		info, err := os.Stat(in)
		switch {
		case err != nil:
			fields[key] = "File not found"
		case !info.Mode().IsRegular():
			fields[key] = "Not a file"
		default:
			ext := strings.ToLower(filepath.Ext(in))
			if !slices.Contains(exts, ext) {
				if ext == "" {
					ext = "no extension"
				}
				fields[key] = fmt.Sprintf("Unsupported file type (%s)", ext)
			}
		}
	}
	if len(fields) > 0 {
		return ValidationError("Some files can't be used", fields)
	}
	return nil
}

// StatFiles describes paths for the UI's input lists.
func StatFiles(paths []string) []FileInfo {
	out := make([]FileInfo, 0, len(paths))
	for _, p := range paths {
		fi := FileInfo{Path: p, Name: filepath.Base(p), Kind: KindForPath(p)}
		if info, err := os.Stat(p); err == nil {
			fi.Exists = true
			fi.IsDir = info.IsDir()
			if !fi.IsDir {
				fi.SizeBytes = info.Size()
			}
		}
		out = append(out, fi)
	}
	return out
}

// UniquePath returns dir/<stem><ext>, or dir/<stem> (1)<ext>, (2)… if taken.
// It never returns an existing path.
func UniquePath(dir, stem, ext string) string {
	p := filepath.Join(dir, stem+ext)
	for i := 1; ; i++ {
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
	}
}

// StemName is a file's base name without its extension.
func StemName(path string) string {
	base := filepath.Base(path)
	return strings.TrimSuffix(base, filepath.Ext(base))
}
