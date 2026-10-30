package lyricvideo

import "toolbox/core/lyrics"

// The timed-lyrics logic lives in core/lyrics (SPEC.md §4.2); these keep
// Lyric Video's names.
type (
	recWord    = lyrics.Word
	recSegment = lyrics.Segment
)

func splitWords(text string) []string { return lyrics.SplitWords(text) }
func spreadWords(l *LyricLine)        { lyrics.SpreadWords(l) }

// AlignLyrics times pasted lyrics to recognised words (lyrics.Align).
func AlignLyrics(text string, rec []recWord) ([]LyricLine, float64) { return lyrics.Align(text, rec) }

// DetectLines groups recognised words into lines (lyrics.DetectLines).
func DetectLines(segs []recSegment) []LyricLine { return lyrics.DetectLines(segs) }

// ParseLRC parses (enhanced) LRC (lyrics.ParseLRC).
func ParseLRC(text string) []LyricLine { return lyrics.ParseLRC(text) }

// ParseCues parses SRT/VTT cues into lines (lyrics.ParseCues).
func ParseCues(text string) []LyricLine { return lyrics.ParseCues(text) }

// FormatLRC writes an enhanced LRC (lyrics.FormatLRC).
func FormatLRC(lines []LyricLine, title, artist string) string {
	return lyrics.FormatLRC(lines, title, artist)
}

func needSpace(prev, next string) bool { return lyrics.NeedSpace(prev, next) }
