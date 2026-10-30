package lyrics

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ParseFile reads timed lyrics from .lrc, .srt or .vtt. Any other file is
// returned as needsAlign with its text, to be aligned to the song.
func ParseFile(path string) (lines []Line, text string, needsAlign bool, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", false, fmt.Errorf("reading lyrics: %w", err)
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".lrc":
		return ParseLRC(string(data)), "", false, nil
	case ".srt", ".vtt":
		return ParseCues(string(data)), "", false, nil
	default:
		return nil, strings.TrimPrefix(string(data), bom), true, nil
	}
}
