// Package doctext extracts plain text from documents in pure Go for Smart
// search (Phase 20, SPEC.md §1.2): txt/md/csv/json, srt/vtt/lrc/ass, html,
// docx/pptx/xlsx, odt/odp/ods and epub. It never runs a subprocess and never
// writes to disk.
package doctext

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// DefaultLimit is how much text Extract reads from one file.
const DefaultLimit = 2 << 20

// ChunkChars is the target chunk size; chunks split on line boundaries.
const ChunkChars = 1000

// Chunk is a piece of a document's text. Pos is the page/slide/sheet index
// (0-based) where the format has one, or a subtitle cue's start ms for
// srt/vtt/lrc/ass (with EndPos), else -1.
type Chunk struct {
	Pos    int64
	EndPos int64
	Text   string
}

var exts = map[string]bool{
	".txt": true, ".md": true, ".markdown": true, ".csv": true, ".json": true,
	".srt": true, ".vtt": true, ".lrc": true, ".ass": true,
	".html": true, ".htm": true,
	".docx": true, ".pptx": true, ".xlsx": true,
	".odt": true, ".odp": true, ".ods": true,
	".epub": true,
}

// Supported reports whether Extract reads files with this name's extension.
func Supported(path string) bool { return exts[strings.ToLower(filepath.Ext(path))] }

// IsSubtitle reports whether path is a cue-based format (srt, vtt, lrc, ass),
// whose chunks are single cues with Pos/EndPos in ms.
func IsSubtitle(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".srt", ".vtt", ".lrc", ".ass":
		return true
	}
	return false
}

// Extensions lists the supported extensions (lowercase, with the dot), sorted.
func Extensions() []string {
	out := make([]string, 0, len(exts))
	for e := range exts {
		out = append(out, e)
	}
	sort.Strings(out)
	return out
}

// section is text with the page/slide/sheet index it came from (-1 = none).
type section struct {
	pos  int64
	text string
}

// Extract reads up to limit bytes of text (0 = DefaultLimit) from path as
// chunks of about ChunkChars. Zip formats are read with capped, path-safe
// entry sizes. An unsupported or unreadable file is a ValidationError with
// a one-line reason.
func Extract(path string, limit int) ([]Chunk, error) {
	if limit <= 0 {
		limit = DefaultLimit
	}
	ext := strings.ToLower(filepath.Ext(path))
	if !exts[ext] {
		return nil, core.ValidationError("This kind of file can't be read for text", nil)
	}
	name := filepath.Base(path)
	secs, cues, err := extract(path, ext, limit)
	if err != nil {
		var ae *core.AppError
		if errors.As(err, &ae) {
			return nil, err
		}
		return nil, core.ValidationError(fmt.Sprintf("Couldn't read %s: %s", name, oneLine(err)), nil)
	}
	if cues != nil {
		return capCues(cues, limit), nil
	}
	return chunkSections(secs, limit), nil
}

func extract(path, ext string, limit int) ([]section, []Chunk, error) {
	switch ext {
	case ".srt", ".vtt", ".lrc", ".ass":
		b, err := readCapped(path, limit*4+4096)
		if err != nil {
			return nil, nil, err
		}
		cues := parseSubs(ext, cleanUTF8(b))
		if cues == nil {
			cues = []Chunk{}
		}
		return nil, cues, nil
	case ".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".epub":
		secs, err := extractZip(path, ext, limit)
		return secs, nil, err
	}
	b, err := readCapped(path, limit+4)
	if err != nil {
		return nil, nil, err
	}
	text := cleanUTF8(b)
	if ext == ".html" || ext == ".htm" {
		text = htmlText(text, limit)
	}
	return []section{{pos: -1, text: text}}, nil, nil
}

// readCapped reads at most n bytes of a regular file.
func readCapped(path string, n int) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, core.ValidationError("This isn't a regular file", nil)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, int64(n)))
}

// cleanUTF8 drops a BOM and replaces invalid bytes.
func cleanUTF8(b []byte) string {
	s := strings.TrimPrefix(string(b), "\xef\xbb\xbf")
	return strings.ToValidUTF8(s, "�")
}

func oneLine(err error) string {
	s := strings.Join(strings.Fields(err.Error()), " ")
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// truncateBytes cuts s to at most n bytes on a rune boundary.
func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// chunkSections splits each section's text and keeps the total ≤ limit.
func chunkSections(secs []section, limit int) []Chunk {
	out := []Chunk{}
	used := 0
	for _, s := range secs {
		for _, part := range SplitText(s.text) {
			if used+len(part) > limit {
				part = strings.TrimSpace(truncateBytes(part, limit-used))
				if part != "" {
					out = append(out, Chunk{Pos: s.pos, EndPos: -1, Text: part})
				}
				return out
			}
			used += len(part)
			out = append(out, Chunk{Pos: s.pos, EndPos: -1, Text: part})
		}
	}
	return out
}

func capCues(cues []Chunk, limit int) []Chunk {
	out := cues[:0:0]
	used := 0
	for _, c := range cues {
		if used+len(c.Text) > limit {
			break
		}
		used += len(c.Text)
		out = append(out, c)
	}
	return out
}

// SplitText splits text into pieces of about ChunkChars characters on line
// (and so paragraph) boundaries; a single longer line is cut at a space.
// Pieces are trimmed and never empty.
func SplitText(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	var out []string
	var buf strings.Builder
	n := 0
	flush := func() {
		if s := strings.TrimSpace(buf.String()); s != "" {
			out = append(out, s)
		}
		buf.Reset()
		n = 0
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, " \t")
		for utf8.RuneCountInString(line) > ChunkChars {
			cut := cutPoint(line, ChunkChars)
			if n > 0 {
				flush()
			}
			out = append(out, strings.TrimSpace(line[:cut]))
			line = strings.TrimLeft(line[cut:], " \t")
		}
		l := utf8.RuneCountInString(line)
		if n > 0 && n+l+1 > ChunkChars {
			flush()
		}
		if buf.Len() > 0 {
			buf.WriteByte('\n')
			n++
		}
		buf.WriteString(line)
		n += l
	}
	flush()
	return out
}

// cutPoint returns the byte index at which to cut line after at most max
// runes, preferring the last space in the final fifth.
func cutPoint(line string, max int) int {
	i, runes := 0, 0
	lastSpace := -1
	for i < len(line) && runes < max {
		r, w := utf8.DecodeRuneInString(line[i:])
		if r == ' ' || r == '\t' {
			if runes > max*4/5 {
				lastSpace = i
			}
		}
		i += w
		runes++
	}
	if lastSpace > 0 {
		return lastSpace
	}
	return i
}
