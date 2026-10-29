package subtitles

import (
	"fmt"
	"strings"
	"testing"
)

// words builds 300 ms words starting at startMs, gap ms apart.
func words(startMs, gap int64, ws ...string) []rawWord {
	var out []rawWord
	t := startMs
	for i, w := range ws {
		txt := w
		if i > 0 {
			txt = " " + w
		}
		out = append(out, rawWord{StartMs: t, EndMs: t + 300, Text: txt})
		t += 300 + gap
	}
	return out
}

func seg(ws []rawWord) rawSegment {
	return rawSegment{StartMs: ws[0].StartMs, EndMs: ws[len(ws)-1].EndMs, Words: ws}
}

func checkLimits(t *testing.T, cues []Cue, lineLen, maxLines int) {
	t.Helper()
	for i, c := range cues {
		lines := strings.Split(c.Text, "\n")
		if len(lines) > maxLines {
			t.Errorf("cue %d has %d lines: %q", i, len(lines), c.Text)
		}
		for _, l := range lines {
			if runeLen(l) > lineLen {
				t.Errorf("cue %d line too long (%d): %q", i, runeLen(l), l)
			}
		}
		if c.EndMs-c.StartMs > maxCueMs {
			t.Errorf("cue %d lasts %d ms", i, c.EndMs-c.StartMs)
		}
		if c.EndMs <= c.StartMs {
			t.Errorf("cue %d has no duration", i)
		}
		if i > 0 && c.StartMs < cues[i-1].EndMs {
			t.Errorf("cue %d overlaps the previous one", i)
		}
	}
}

func TestSentenceBreaks(t *testing.T) {
	ws := words(0, 20, "Hello", "there", "my", "friend.", "How", "are", "you", "doing", "today?")
	cues := buildCues([]rawSegment{seg(ws)}, 42, 2)
	if len(cues) != 2 {
		t.Fatalf("got %d cues: %+v", len(cues), cues)
	}
	if got := strings.ReplaceAll(cues[0].Text, "\n", " "); got != "Hello there my friend." {
		t.Errorf("first cue %q", got)
	}
	checkLimits(t, cues, 42, 2)
}

func TestPauseBreak(t *testing.T) {
	a := words(0, 20, "this", "is", "the", "first", "part", "of")
	b := words(a[len(a)-1].EndMs+600, 20, " something", "longer", "than", "a", "single", "line", "can", "hold", "really", "and", "more", "words", "to", "overflow")
	cues := buildCues([]rawSegment{seg(append(a, b...))}, 42, 2)
	if len(cues) < 2 {
		t.Fatalf("expected a split, got %+v", cues)
	}
	if !strings.HasPrefix(strings.ReplaceAll(cues[1].Text, "\n", " "), "something") {
		t.Errorf("break not at the pause: %q | %q", cues[0].Text, cues[1].Text)
	}
	checkLimits(t, cues, 42, 2)
}

func TestCharLimitsAndLineBalance(t *testing.T) {
	var ws []string
	for i := 0; i < 40; i++ {
		ws = append(ws, fmt.Sprintf("word%02d", i))
	}
	cues := buildCues([]rawSegment{seg(words(0, 10, ws...))}, 32, 2)
	checkLimits(t, cues, 32, 2)
	if len(cues) < 3 {
		t.Errorf("expected several cues, got %d", len(cues))
	}
	one := buildCues([]rawSegment{seg(words(0, 10, ws[:10]...))}, 42, 1)
	checkLimits(t, one, 42, 1)
}

func TestWrapLines(t *testing.T) {
	tests := []struct {
		in       string
		lineLen  int
		maxLines int
		want     string
	}{
		{"short text", 42, 2, "short text"},
		{"one two three four five six seven eight nine ten eleven", 32, 1, "one two three four five six seven eight nine ten eleven"},
		{"I really think this is the best option, and we should take it now", 42, 2, "I really think this is the best\noption, and we should take it now"},
		{"one two three, four five six seven", 20, 2, "one two three,\nfour five six seven"},
		{"aaaa bbbb cccc dddd eeee ffff gggg hhhh", 20, 2, "aaaa bbbb cccc dddd\neeee ffff gggg hhhh"},
	}
	for _, tt := range tests {
		if got := wrapLines(tt.in, tt.lineLen, tt.maxLines); got != tt.want {
			t.Errorf("wrap(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestMaxDuration(t *testing.T) {
	// 24 short words, slow speech: spans > 7 s, must split.
	var ws []rawWord
	for i := 0; i < 24; i++ {
		ws = append(ws, rawWord{StartMs: int64(i) * 800, EndMs: int64(i)*800 + 300, Text: " ab"})
	}
	cues := buildCues([]rawSegment{seg(ws)}, 60, 2)
	if len(cues) < 3 {
		t.Fatalf("expected a split into several cues, got %d", len(cues))
	}
	checkLimits(t, cues, 60, 2)
}

func TestMinDurationAndGap(t *testing.T) {
	a := words(0, 0, "Hi.")
	b := words(5000, 0, "Okay", "then.")
	cues := buildCues([]rawSegment{seg(a), seg(b)}, 42, 2)
	if len(cues) != 2 {
		t.Fatalf("got %+v", cues)
	}
	if d := cues[0].EndMs - cues[0].StartMs; d != minCueMs {
		t.Errorf("short cue lasts %d, want %d", d, minCueMs)
	}
	// Tight gap: the next cue starts at 500 ms, so the end keeps 80 ms before it.
	c := []rawSegment{seg(words(0, 0, "Hi.")), seg(words(500, 0, "Okay", "then."))}
	cues = buildCues(c, 42, 2)
	if cues[0].EndMs != 500-gapMs {
		t.Errorf("end %d, want %d", cues[0].EndMs, 500-gapMs)
	}
}

func TestReadingSpeedExtends(t *testing.T) {
	// 59 chars in 1.5 s is about 39 cps: needs about 3 s, the gap is free.
	text := strings.TrimSpace(strings.Repeat("abcdefghi ", 6))
	s := rawSegment{StartMs: 0, EndMs: 1500, Text: text}
	cues := buildCues([]rawSegment{s, {StartMs: 10000, EndMs: 11000, Text: "later"}}, 60, 2)
	if got := cues[0].EndMs; got < 2900 || got > 3100 {
		t.Errorf("reading-speed end = %d, want about 3000", got)
	}
}

func TestSegmentWithoutWords(t *testing.T) {
	s := rawSegment{StartMs: 1000, EndMs: 5000, Text: "This segment has no word timings, so the text is spread across the whole span evenly."}
	cues := buildCues([]rawSegment{s}, 42, 2)
	if len(cues) == 0 {
		t.Fatal("no cues")
	}
	if cues[0].StartMs != 1000 {
		t.Errorf("start %d", cues[0].StartMs)
	}
	checkLimits(t, cues, 42, 2)
	var joined string
	for _, c := range cues {
		joined += strings.ReplaceAll(c.Text, "\n", " ") + " "
	}
	if strings.Join(strings.Fields(joined), " ") != s.Text {
		t.Errorf("text changed: %q", joined)
	}
}

func TestCJK(t *testing.T) {
	text := strings.Repeat("今日は天気がとても良いですね。", 5)
	s := rawSegment{StartMs: 0, EndMs: 12000, Text: text}
	cues := buildCues([]rawSegment{s}, 42, 2)
	if len(cues) < 2 {
		t.Fatalf("expected a split, got %d", len(cues))
	}
	checkLimits(t, cues, cjkLineChars, 2)
	var joined string
	for _, c := range cues {
		joined += strings.ReplaceAll(c.Text, "\n", "")
	}
	if strings.ReplaceAll(joined, " ", "") != text {
		t.Errorf("CJK text changed: %q", joined)
	}
}

func TestEmptyAndWhitespace(t *testing.T) {
	if cues := buildCues([]rawSegment{{StartMs: 0, EndMs: 1000, Text: "  "}}, 42, 2); len(cues) != 0 {
		t.Errorf("got %+v", cues)
	}
	if cues := buildCues(nil, 0, 0); len(cues) != 0 {
		t.Errorf("got %+v", cues)
	}
}

func TestRewrap(t *testing.T) {
	if got := rewrap("fits\nfine", 42); got != "fits\nfine" {
		t.Errorf("got %q", got)
	}
	long := "this translated sentence is much longer than a single subtitle line should ever be"
	for _, l := range strings.Split(rewrap(long, 42), "\n") {
		if runeLen(l) > 42 {
			t.Errorf("line too long: %q", l)
		}
	}
}
