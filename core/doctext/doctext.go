// Package doctext extracts plain text from documents in pure Go for Smart
// search (Phase 20, SPEC.md §1.2): txt/md/csv/json, srt/vtt/lrc/ass, html,
// docx/pptx/xlsx, odt/odp/ods and epub. It never runs a subprocess.
//
// CONTRACT STUB (Wave 0): S3 implements Extract. Signatures are frozen.
package doctext

import (
	"path/filepath"
	"sort"
	"strings"

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

// Extensions lists the supported extensions (lowercase, with the dot), sorted.
func Extensions() []string {
	out := make([]string, 0, len(exts))
	for e := range exts {
		out = append(out, e)
	}
	sort.Strings(out)
	return out
}

// Extract reads up to limit bytes of text (0 = DefaultLimit) from path as
// chunks of about ChunkChars. Zip formats are read with capped, path-safe
// entry sizes. An unsupported or unreadable file is a ValidationError with
// a one-line reason.
func Extract(path string, limit int) ([]Chunk, error) {
	return nil, core.Errorf(core.CodeNotImplemented, "Reading documents isn't ready yet")
}
