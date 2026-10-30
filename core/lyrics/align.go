package lyrics

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r)
}

func HasCJK(s string) bool {
	for _, r := range s {
		if isCJK(r) {
			return true
		}
	}
	return false
}

// SplitWords splits text into display words: whitespace-separated, with
// every CJK character on its own (those scripts have no spaces).
func SplitWords(text string) []string {
	var out []string
	for _, f := range strings.Fields(text) {
		if !HasCJK(f) {
			out = append(out, f)
			continue
		}
		var cur []rune
		flush := func() {
			if len(cur) > 0 {
				out = append(out, string(cur))
				cur = cur[:0]
			}
		}
		for _, r := range f {
			if isCJK(r) {
				flush()
				out = append(out, string(r))
			} else {
				cur = append(cur, r)
			}
		}
		flush()
	}
	return out
}

// JoinWords is the inverse of SplitWords for display: a space between
// words except next to CJK characters.
func JoinWords(words []string) string {
	var b strings.Builder
	for i, w := range words {
		if i > 0 && NeedSpace(words[i-1], w) {
			b.WriteByte(' ')
		}
		b.WriteString(w)
	}
	return b.String()
}

func NeedSpace(prev, next string) bool {
	if prev == "" || next == "" {
		return false
	}
	pr, _ := utf8.DecodeLastRuneInString(prev)
	nr, _ := utf8.DecodeRuneInString(next)
	return !isCJK(pr) && !isCJK(nr)
}

// normToken folds a word for comparison: fullwidth ASCII to ASCII,
// lowercase, and everything that isn't a letter, digit or mark removed.
// (A light stand-in for NFKC + punctuation stripping.)
func normToken(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		}
		r = unicode.ToLower(r)
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func levenshtein(a, b []rune) int {
	if len(a) == 0 {
		return len(b)
	}
	if len(b) == 0 {
		return len(a)
	}
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

// similarity is 1 - lev/max(len) over runes, in 0..1.
func similarity(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	m := max(len(ra), len(rb))
	if m == 0 {
		return 1
	}
	return 1 - float64(levenshtein(ra, rb))/float64(m)
}

const (
	matchSim    = 0.6 // normalised similarity needed to count as a match
	gapScore    = -1.0
	missScore   = -1.0
	maxDPCells  = 16_000_000
	unmatchedMs = 300 // per word for leading/trailing unmatched runs
)

// needlemanWunsch aligns lyric tokens a to recognised tokens b and returns,
// for each a, the matching index in b or -1. Matches score 2*similarity when
// similarity >= matchSim; any other diagonal step scores -1 and does not
// count as a match; a gap scores -1.
func needlemanWunsch(a, b []string) []int {
	res := make([]int, len(a))
	for i := range res {
		res[i] = -1
	}
	n, m := len(a), len(b)
	if n == 0 || m == 0 || n*m > maxDPCells {
		return res
	}
	sim := func(i, j int) float64 { return similarity(a[i], b[j]) }
	w := m + 1
	score := make([]float32, (n+1)*w)
	back := make([]byte, (n+1)*w) // 0 diag, 1 up (a gap in b), 2 left
	for i := 1; i <= n; i++ {
		score[i*w] = float32(i) * gapScore
		back[i*w] = 1
	}
	for j := 1; j <= m; j++ {
		score[j] = float32(j) * gapScore
		back[j] = 2
	}
	for i := 1; i <= n; i++ {
		for j := 1; j <= m; j++ {
			s := sim(i-1, j-1)
			d := float32(missScore)
			if s >= matchSim {
				d = float32(2 * s)
			}
			diag := score[(i-1)*w+j-1] + d
			up := score[(i-1)*w+j] + gapScore
			left := score[i*w+j-1] + gapScore
			best, dir := diag, byte(0)
			if up > best {
				best, dir = up, 1
			}
			if left > best {
				best, dir = left, 2
			}
			score[i*w+j], back[i*w+j] = best, dir
		}
	}
	i, j := n, m
	for i > 0 || j > 0 {
		switch back[i*w+j] {
		case 0:
			if sim(i-1, j-1) >= matchSim {
				res[i-1] = j - 1
			}
			i--
			j--
		case 1:
			i--
		default:
			j--
		}
	}
	return res
}

type lyricToken struct {
	line       int
	text, norm string
	start, end int64
	matched    bool
}

// Align times pasted lyrics to recognised words. Blank lines are
// dropped; each remaining line keeps its text and gets word times. matched
// is the share of lyric tokens that found a recognised word (0..1).
func Align(text string, rec []Word) (lines []Line, matched float64) {
	var toks []lyricToken
	var lineCount int
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		for _, ch := range SplitWords(raw) {
			toks = append(toks, lyricToken{line: lineCount, text: ch, norm: normToken(ch)})
		}
		lineCount++
	}
	if lineCount == 0 {
		return []Line{}, 0
	}

	var recNorm []string
	var recIdx []int
	for i, w := range rec {
		if n := normToken(w.Text); n != "" {
			recNorm = append(recNorm, n)
			recIdx = append(recIdx, i)
		}
	}
	var aNorm []string
	var aIdx []int
	for i, t := range toks {
		if t.norm != "" {
			aNorm = append(aNorm, t.norm)
			aIdx = append(aIdx, i)
		}
	}
	hits := 0
	for k, mi := range needlemanWunsch(aNorm, recNorm) {
		if mi < 0 {
			continue
		}
		w := rec[recIdx[mi]]
		t := &toks[aIdx[k]]
		t.start, t.end, t.matched = w.StartMs, max(w.EndMs, w.StartMs), true
		hits++
	}
	if len(aNorm) > 0 {
		matched = float64(hits) / float64(len(aNorm))
	}
	interpolate(toks, rec)

	prev := int64(0)
	for li := 0; li < lineCount; li++ {
		ln := Line{Words: []Word{}}
		var texts []string
		for _, t := range toks {
			if t.line != li {
				continue
			}
			s := max(t.start, prev)
			e := max(t.end, s)
			prev = s // starts never go backwards; ends may overlap the next start only by clamping below
			ln.Words = append(ln.Words, Word{StartMs: s, EndMs: e, Text: t.text})
			texts = append(texts, t.text)
		}
		ln.Text = JoinWords(texts)
		ln.StartMs = ln.Words[0].StartMs
		ln.EndMs = ln.Words[len(ln.Words)-1].EndMs
		lines = append(lines, ln)
	}
	finishLines(lines)
	return lines, matched
}

// interpolate gives unmatched tokens times between their matched
// neighbours, in proportion to character length. Leading and trailing runs
// take 0.3 s per word.
func interpolate(toks []lyricToken, rec []Word) {
	n := len(toks)
	weight := func(t lyricToken) float64 { return float64(max(1, utf8.RuneCountInString(t.text))) }
	for i := 0; i < n; {
		if toks[i].matched {
			i++
			continue
		}
		j := i
		for j < n && !toks[j].matched {
			j++
		}
		hasPrev, hasNext := i > 0, j < n
		var from, to int64
		switch {
		case hasPrev && hasNext:
			from, to = toks[i-1].end, max(toks[i-1].end, toks[j].start)
		case hasNext:
			cnt := int64(j - i)
			from = max(0, toks[j].start-cnt*unmatchedMs)
			to = toks[j].start
		case hasPrev:
			from = toks[i-1].end
			to = from + int64(j-i)*unmatchedMs
		default: // nothing matched at all
			if len(rec) > 0 {
				from, to = rec[0].StartMs, max(rec[0].StartMs, rec[len(rec)-1].EndMs)
			} else {
				from, to = 0, int64(n)*unmatchedMs
			}
		}
		var total float64
		for k := i; k < j; k++ {
			total += weight(toks[k])
		}
		acc := 0.0
		for k := i; k < j; k++ {
			s := from + int64(float64(to-from)*acc/total)
			acc += weight(toks[k])
			e := from + int64(float64(to-from)*acc/total)
			toks[k].start, toks[k].end = s, e
		}
		i = j
	}
}

// finishLines extends each line's end to just before the next line (at most
// 1.5 s), keeps the sheet ordered and clamps word times into their line.
func finishLines(lines []Line) {
	for i := range lines {
		l := &lines[i]
		limit := l.EndMs + 1500
		if i+1 < len(lines) {
			limit = min(limit, lines[i+1].StartMs-100)
		}
		if limit > l.EndMs {
			l.EndMs = limit
		}
		if l.EndMs < l.StartMs {
			l.EndMs = l.StartMs
		}
	}
	clampOverlaps(lines)
}

// SpreadWords gives a line without word times its words, sharing the line's
// duration by character count.
func SpreadWords(l *Line) {
	words := SplitWords(l.Text)
	l.Words = []Word{}
	if len(words) == 0 {
		return
	}
	total := 0
	for _, w := range words {
		total += max(1, utf8.RuneCountInString(w))
	}
	span := l.EndMs - l.StartMs
	acc := 0
	for _, w := range words {
		s := l.StartMs + span*int64(acc)/int64(total)
		acc += max(1, utf8.RuneCountInString(w))
		e := l.StartMs + span*int64(acc)/int64(total)
		l.Words = append(l.Words, Word{StartMs: s, EndMs: e, Text: w})
	}
}

// DetectLines groups recognised words into lines: a break at a segment
// boundary, a pause of 600 ms or more, or past 8 words / 40 characters
// (16 characters for CJK text, which has no word limit).
func DetectLines(segs []Segment) []Line {
	var lines []Line
	var cur []Word
	flush := func() {
		if len(cur) == 0 {
			return
		}
		texts := make([]string, len(cur))
		ln := Line{StartMs: cur[0].StartMs, EndMs: cur[len(cur)-1].EndMs, Words: make([]Word, len(cur))}
		for i, w := range cur {
			texts[i] = w.Text
			ln.Words[i] = Word{StartMs: w.StartMs, EndMs: max(w.EndMs, w.StartMs), Text: w.Text}
		}
		ln.Text = JoinWords(texts)
		ln.EndMs = max(ln.EndMs, ln.StartMs)
		lines = append(lines, ln)
		cur = nil
	}
	for _, seg := range segs {
		var words []Word
		for _, w := range seg.Words {
			if t := strings.TrimSpace(w.Text); t != "" {
				w.Text = t
				words = append(words, w)
			}
		}
		if len(words) == 0 {
			if t := strings.TrimSpace(seg.Text); t != "" {
				flush()
				ln := Line{StartMs: seg.StartMs, EndMs: max(seg.EndMs, seg.StartMs), Text: t}
				SpreadWords(&ln)
				lines = append(lines, ln)
			}
			continue
		}
		flush() // a segment boundary
		for _, w := range words {
			if len(cur) > 0 {
				prev := cur[len(cur)-1]
				texts := make([]string, 0, len(cur)+1)
				for _, c := range cur {
					texts = append(texts, c.Text)
				}
				texts = append(texts, w.Text)
				joined := JoinWords(texts)
				cjk := HasCJK(joined)
				limit := 40
				if cjk {
					limit = 16
				}
				if w.StartMs-prev.EndMs >= 600 || (!cjk && len(cur)+1 > 8) || utf8.RuneCountInString(joined) > limit {
					flush()
				}
			}
			cur = append(cur, w)
		}
	}
	flush()
	if lines == nil {
		lines = []Line{}
	}
	finishLines(lines)
	return lines
}
