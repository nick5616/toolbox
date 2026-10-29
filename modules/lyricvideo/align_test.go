package lyricvideo

import (
	"fmt"
	"strings"
	"testing"
)

func TestNormToken(t *testing.T) {
	tests := map[string]string{
		"Hello,": "hello", "I've": "ive", "(Oh!)": "oh", "Ｆｕｌｌ": "full", "---": "", "Ünï": "ünï", "123": "123",
	}
	for in, want := range tests {
		if got := normToken(in); got != want {
			t.Errorf("normToken(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSimilarity(t *testing.T) {
	tests := []struct {
		a, b string
		want float64
	}{{"abc", "abc", 1}, {"", "", 1}, {"abc", "", 0}, {"kitten", "sitting", 1 - 3.0/7}}
	for _, tc := range tests {
		if got := similarity(tc.a, tc.b); got < tc.want-1e-9 || got > tc.want+1e-9 {
			t.Errorf("similarity(%q,%q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestSplitAndJoinWords(t *testing.T) {
	if got := splitWords("Hello  world"); len(got) != 2 {
		t.Errorf("latin = %v", got)
	}
	got := splitWords("我爱 you 日本語です")
	want := []string{"我", "爱", "you", "日", "本", "語", "で", "す"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		// "です" is kana: each kana on its own is the documented behaviour
		t.Errorf("cjk = %v, want %v", got, want)
	}
	if j := joinWords([]string{"我", "爱", "you", "now"}); j != "我爱you now" {
		t.Errorf("join = %q", j)
	}
}

func rw(start, end int64, text string) recWord { return recWord{start, end, text} }

// words builds recognised words at 500 ms each with a 100 ms gap, starting at t0.
func words(t0 int64, texts ...string) []recWord {
	var out []recWord
	t := t0
	for _, x := range texts {
		out = append(out, rw(t, t+400, x))
		t += 500
	}
	return out
}

func TestAlignExact(t *testing.T) {
	rec := words(1000, "hello", "darkness", "my", "old", "friend", "ive", "come", "to", "talk", "with", "you", "again")
	text := "Hello darkness, my old friend\n\nI've come to talk with you again\n"
	lines, matched := AlignLyrics(text, rec)
	if matched != 1 {
		t.Fatalf("matched = %v", matched)
	}
	if len(lines) != 2 {
		t.Fatalf("lines = %d", len(lines))
	}
	if lines[0].Text != "Hello darkness, my old friend" || lines[1].Text != "I've come to talk with you again" {
		t.Errorf("text = %q / %q", lines[0].Text, lines[1].Text)
	}
	if lines[0].StartMs != 1000 || lines[1].StartMs != 3500 {
		t.Errorf("starts = %d, %d", lines[0].StartMs, lines[1].StartMs)
	}
	if lines[0].Words[1].StartMs != 1500 || lines[0].Words[1].EndMs != 1900 {
		t.Errorf("word times = %+v", lines[0].Words[1])
	}
	// The first line is extended to just before the next (limited to +1.5 s).
	if lines[0].EndMs != 3400 {
		t.Errorf("end = %d, want 3400", lines[0].EndMs)
	}
}

func TestAlignTolerance(t *testing.T) {
	// Whisper mishears "darkness" and drops "old"; adds a stray word.
	rec := words(0, "hello", "darkest", "my", "friend", "uh", "ive", "come", "to", "talk")
	text := "Hello darkness my old friend\nI've come to talk"
	lines, matched := AlignLyrics(text, rec)
	if len(lines) != 2 {
		t.Fatalf("lines = %d", len(lines))
	}
	// darkness~darkest similarity 0.75 counts; "old" is unmatched: 8 of 9 tokens.
	if matched < 0.85 || matched > 0.9 {
		t.Errorf("matched = %v, want 8/9", matched)
	}
	// The unmatched "old" sits between "my" (ends 1400) and "friend" (starts 1500).
	old := lines[0].Words[3]
	if old.Text != "old" || old.StartMs < 1400 || old.EndMs > 1500 || old.StartMs > old.EndMs {
		t.Errorf("old = %+v", old)
	}
	// Second line starts at "ive" (2500).
	if lines[1].StartMs != 2500 {
		t.Errorf("second start = %d", lines[1].StartMs)
	}
	assertMonotonic(t, lines)
}

func TestAlignLeadingTrailingAndNothing(t *testing.T) {
	rec := words(5000, "middle", "words")
	lines, matched := AlignLyrics("intro one two\nmiddle words\nout one", rec)
	if len(lines) != 3 {
		t.Fatalf("lines = %d", len(lines))
	}
	if matched != 2.0/7 {
		t.Errorf("matched = %v", matched)
	}
	// Leading run: 2 words x 300 ms before 5000... 3 words here, so 900 ms.
	if lines[0].StartMs != 4100 || lines[0].Words[2].EndMs != 5000 {
		t.Errorf("leading = %+v", lines[0])
	}
	// Trailing run: 300 ms each after the last matched word's end (5900).
	if lines[2].StartMs != 5900 || lines[2].Words[1].EndMs != 6500 {
		t.Errorf("trailing = %+v", lines[2])
	}
	assertMonotonic(t, lines)

	// Nothing recognised: spread at 300 ms per word from 0.
	lines, matched = AlignLyrics("a b c", nil)
	if matched != 0 || len(lines) != 1 || lines[0].StartMs != 0 || lines[0].Words[2].EndMs != 900 {
		t.Errorf("no words: %v %+v", matched, lines)
	}
	// Nothing matches: the words are spread over the recognised span.
	lines, matched = AlignLyrics("zzz yyy", words(1000, "qqq", "www"))
	if matched != 0 || lines[0].StartMs != 1000 || lines[0].Words[1].EndMs != 1900 {
		t.Errorf("no match: %v %+v", matched, lines[0])
	}
	// Empty text.
	if lines, m := AlignLyrics("  \n\n", rec); len(lines) != 0 || m != 0 {
		t.Errorf("empty text: %v %v", lines, m)
	}
}

func TestAlignRepeatedChorusStaysInOrder(t *testing.T) {
	chorus := []string{"la", "la", "land"}
	var rec []recWord
	rec = append(rec, words(0, chorus...)...)
	rec = append(rec, words(10000, "verse", "two")...)
	rec = append(rec, words(20000, chorus...)...)
	text := "la la land\nverse two\nla la land"
	lines, matched := AlignLyrics(text, rec)
	if matched != 1 || lines[0].StartMs != 0 || lines[1].StartMs != 10000 || lines[2].StartMs != 20000 {
		t.Fatalf("matched %v, lines %+v", matched, lines)
	}
}

func TestAlignPunctuationOnlyChunk(t *testing.T) {
	lines, matched := AlignLyrics("hello - world", words(0, "hello", "world"))
	if matched != 1 || len(lines[0].Words) != 3 || lines[0].Words[1].Text != "-" {
		t.Fatalf("matched %v, %+v", matched, lines[0])
	}
	assertMonotonic(t, lines)
}

func TestAlignHugeInputFallsBack(t *testing.T) {
	var sb strings.Builder
	var rec []recWord
	for i := 0; i < 4500; i++ {
		fmt.Fprintf(&sb, "word%d ", i)
		rec = append(rec, rw(int64(i)*100, int64(i)*100+80, fmt.Sprintf("word%d", i)))
	}
	lines, matched := AlignLyrics(sb.String(), rec) // 4500x4500 > the DP cap
	if matched != 0 || len(lines) != 1 || len(lines[0].Words) != 4500 {
		t.Fatalf("matched %v, %d lines", matched, len(lines))
	}
	assertMonotonic(t, lines)
}

func assertMonotonic(t *testing.T, lines []LyricLine) {
	t.Helper()
	prev := int64(0)
	for i, l := range lines {
		if l.StartMs < prev {
			t.Errorf("line %d starts at %d before %d", i, l.StartMs, prev)
		}
		if l.EndMs < l.StartMs {
			t.Errorf("line %d ends before it starts: %+v", i, l)
		}
		if i+1 < len(lines) && l.EndMs > lines[i+1].StartMs {
			t.Errorf("line %d overlaps the next: %d > %d", i, l.EndMs, lines[i+1].StartMs)
		}
		for j, w := range l.Words {
			if w.EndMs < w.StartMs || w.StartMs < l.StartMs || w.EndMs > l.EndMs {
				t.Errorf("line %d word %d outside its line: %+v in %d..%d", i, j, w, l.StartMs, l.EndMs)
			}
		}
		prev = l.StartMs
	}
}

func TestDetectLines(t *testing.T) {
	t.Run("breaks at segments, pauses and length", func(t *testing.T) {
		segs := []recSegment{
			{Words: []recWord{rw(0, 400, " one"), rw(500, 900, "two"), rw(1000, 1400, "three")}},
			// pause of 700 ms inside a segment
			{Words: []recWord{rw(5000, 5400, "four"), rw(6100, 6500, "five")}},
		}
		lines := DetectLines(segs)
		var texts []string
		for _, l := range lines {
			texts = append(texts, l.Text)
		}
		if strings.Join(texts, "|") != "one two three|four|five" {
			t.Fatalf("lines = %v", texts)
		}
		// Line end: last word end extended to the next start - 100 ms, at most +1.5 s (line 2: 6100 - 100).
		if lines[0].EndMs != 2900 || lines[1].EndMs != 6000 {
			t.Errorf("ends = %d, %d", lines[0].EndMs, lines[1].EndMs)
		}
		if lines[2].EndMs != 8000 {
			t.Errorf("last end = %d, want 8000 (+1.5 s)", lines[2].EndMs)
		}
		assertMonotonic(t, lines)
	})
	t.Run("more than 8 words splits", func(t *testing.T) {
		var ws []recWord
		for i := 0; i < 10; i++ {
			ws = append(ws, rw(int64(i)*300, int64(i)*300+250, "a"))
		}
		lines := DetectLines([]recSegment{{Words: ws}})
		if len(lines) != 2 || len(lines[0].Words) != 8 || len(lines[1].Words) != 2 {
			t.Fatalf("lines = %+v", lines)
		}
	})
	t.Run("more than 40 characters splits", func(t *testing.T) {
		long := "extraordinarily"
		lines := DetectLines([]recSegment{{Words: []recWord{rw(0, 200, long), rw(250, 450, long), rw(500, 700, long), rw(750, 950, long)}}})
		if len(lines) != 2 || lines[0].Text != long+" "+long {
			t.Fatalf("lines = %+v", lines)
		}
	})
	t.Run("CJK splits at 16 characters, no word limit", func(t *testing.T) {
		var ws []recWord
		for i := 0; i < 20; i++ {
			ws = append(ws, rw(int64(i)*200, int64(i)*200+150, "字"))
		}
		lines := DetectLines([]recSegment{{Words: ws}})
		if len(lines) != 2 || len(lines[0].Words) != 16 || strings.Contains(lines[0].Text, " ") {
			t.Fatalf("lines = %d, first has %d words, %q", len(lines), len(lines[0].Words), lines[0].Text)
		}
	})
	t.Run("a segment without words becomes a spread line", func(t *testing.T) {
		lines := DetectLines([]recSegment{{StartMs: 1000, EndMs: 3000, Text: "hello there"}})
		if len(lines) != 1 || len(lines[0].Words) != 2 || lines[0].Words[0].StartMs != 1000 {
			t.Fatalf("lines = %+v", lines)
		}
	})
	t.Run("nothing", func(t *testing.T) {
		if lines := DetectLines(nil); lines == nil || len(lines) != 0 {
			t.Fatalf("lines = %#v", lines)
		}
	})
}

func TestSpreadWords(t *testing.T) {
	l := LyricLine{StartMs: 1000, EndMs: 2000, Text: "aa bbbb"}
	spreadWords(&l)
	if len(l.Words) != 2 || l.Words[0] != (LyricWord{1000, 1333, "aa"}) || l.Words[1] != (LyricWord{1333, 2000, "bbbb"}) {
		t.Fatalf("words = %+v", l.Words)
	}
	empty := LyricLine{Text: "  "}
	spreadWords(&empty)
	if empty.Words == nil || len(empty.Words) != 0 {
		t.Errorf("empty = %#v", empty.Words)
	}
}
