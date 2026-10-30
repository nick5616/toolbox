// Package lyrics holds timed-lyrics logic shared by Lyric Video and the
// Visualizer (SPEC.md §4.2): aligning pasted lyrics, grouping recognised words
// into lines, and LRC/SRT/VTT parsing.
package lyrics

// Word is one timed word (ms).
type Word struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
}

// Line is one timed line; Words may be empty.
type Line struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
	Words   []Word `json:"words"`
}

// Segment is one recognised (Whisper) segment; Words may be empty.
type Segment struct {
	StartMs, EndMs int64
	Text           string
	Words          []Word
}
