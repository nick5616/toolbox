package lyricvideo

import (
	"fmt"

	"toolbox/core"
)

// validateLines checks the sheet sent with render/preview/lrc. Overlapping
// ends are tolerated (renders clamp them); out-of-order starts are not.
func validateLines(lines []LyricLine) error {
	if len(lines) < 1 || len(lines) > 2000 {
		return core.ValidationError("Add between 1 and 2,000 lyric lines", map[string]string{"lines": "Add between 1 and 2,000 lyric lines"})
	}
	for i, l := range lines {
		key := fmt.Sprintf("lines.%d", i)
		switch {
		case l.StartMs < 0 || l.EndMs < l.StartMs:
			return core.ValidationError("A lyric line has invalid times", map[string]string{key: "Invalid times"})
		case i > 0 && l.StartMs < lines[i-1].StartMs:
			return core.ValidationError("Lyric lines must be in time order", map[string]string{key: "Out of order"})
		}
	}
	return nil
}
