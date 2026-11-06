package organize

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"toolbox/core/proc"
)

// exifMeta is what the Organizer reads from a file's metadata.
type exifMeta struct {
	Taken  time.Time // zero = unknown
	Camera string
}

const metaBatch = 200

// readMetaFunc reads metadata for paths (keyed by pathKey). Missing keys mean
// "nothing known". It reports done/total as it goes.
type readMetaFunc func(ctx context.Context, paths []string, progress func(done, total int)) (map[string]exifMeta, error)

// exiftoolReader reads dates and cameras in batches with one ExifTool process
// per batch.
func exiftoolReader(exe string) readMetaFunc {
	return func(ctx context.Context, paths []string, progress func(done, total int)) (map[string]exifMeta, error) {
		out := map[string]exifMeta{}
		for start := 0; start < len(paths); start += metaBatch {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			batch := paths[start:min(start+metaBatch, len(paths))]
			got, err := runExiftool(ctx, exe, batch)
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				// A batch ExifTool can't read isn't fatal: those files use their modified time.
				continue
			}
			for k, v := range got {
				out[k] = v
			}
			if progress != nil {
				progress(min(start+metaBatch, len(paths)), len(paths))
			}
		}
		return out, nil
	}
}

func runExiftool(ctx context.Context, exe string, paths []string) (map[string]exifMeta, error) {
	var mu sync.Mutex
	var stdout bytes.Buffer
	p, err := proc.Start(ctx, proc.Spec{
		Path: exe,
		Args: []string{
			"-charset", "exiftool=utf8", "-charset", "filename=utf8",
			"-j", "-fast2", "-q", "-m",
			"-DateTimeOriginal", "-CreateDate", "-Make", "-Model",
			"-@", "-",
		},
		OnStdout: func(line string) {
			mu.Lock()
			stdout.WriteString(line)
			stdout.WriteByte('\n')
			mu.Unlock()
		},
	})
	if err != nil {
		return nil, fmt.Errorf("start exiftool: %w", err)
	}
	// The file names go over stdin (UTF-8, one per line), so any path works
	// and no argument file is needed.
	var sb strings.Builder
	for _, f := range paths {
		sb.WriteString(f)
		sb.WriteByte('\n')
	}
	_, werr := io.WriteString(p.Stdin(), sb.String())
	_ = p.CloseStdin()
	_, err = p.Wait()
	mu.Lock()
	data := bytes.Clone(stdout.Bytes())
	mu.Unlock()
	if len(bytes.TrimSpace(data)) == 0 {
		if err != nil {
			return nil, fmt.Errorf("run exiftool: %w", err)
		}
		if werr != nil {
			return nil, fmt.Errorf("send file names to exiftool: %w", werr)
		}
		return map[string]exifMeta{}, nil // none of the files had metadata
	}
	return parseExifJSON(data)
}

type exifRow struct {
	SourceFile       string `json:"SourceFile"`
	DateTimeOriginal any    `json:"DateTimeOriginal"`
	CreateDate       any    `json:"CreateDate"`
	Make             any    `json:"Make"`
	Model            any    `json:"Model"`
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case nil:
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

// parseExifJSON reads `exiftool -j` output. DateTimeOriginal wins over CreateDate.
func parseExifJSON(data []byte) (map[string]exifMeta, error) {
	var rows []exifRow
	if err := json.Unmarshal(bytes.TrimSpace(data), &rows); err != nil {
		return nil, fmt.Errorf("parse exiftool output: %w", err)
	}
	out := make(map[string]exifMeta, len(rows))
	for _, r := range rows {
		m := exifMeta{Camera: cameraName(str(r.Make), str(r.Model))}
		for _, s := range []string{str(r.DateTimeOriginal), str(r.CreateDate)} {
			if t, ok := parseExifDate(s); ok {
				m.Taken = t
				break
			}
		}
		out[pathKey(filepath.FromSlash(r.SourceFile))] = m
	}
	return out, nil
}

// parseExifDate reads "2024:06:03 14:22:11" (optionally with fractions or a
// zone) as wall-clock time. Zero dates ("0000:00:00 …") are unknown.
func parseExifDate(s string) (time.Time, bool) {
	if len(s) < 10 {
		return time.Time{}, false
	}
	layout := "2006:01:02 15:04:05"
	if len(s) >= 19 {
		if t, err := time.Parse(layout, s[:19]); err == nil && t.Year() >= 1900 {
			return t, true
		}
		return time.Time{}, false
	}
	if t, err := time.Parse("2006:01:02", s[:10]); err == nil && t.Year() >= 1900 {
		return t, true
	}
	return time.Time{}, false
}
