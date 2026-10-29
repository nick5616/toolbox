package subtitles

import (
	"strings"
	"unicode"
)

// Segmenting rules (SPEC.md §5.2).
const (
	maxCueMs        = 7000
	minCueMs        = 1000
	gapMs           = 80
	pauseBreakMs    = 300
	maxCPS          = 20.0
	cjkLineChars    = 16
	minSentenceRune = 12
)

// rawWord is a word from the engine's JSON, in milliseconds.
type rawWord struct {
	StartMs, EndMs int64
	Text           string
}

// rawSegment is one engine segment.
type rawSegment struct {
	StartMs, EndMs int64
	Text           string
	Words          []rawWord
}

type token struct {
	start, end int64
	text       string // raw, may carry a leading space
}

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul, unicode.Thai)
}

// cjkDominant reports whether most letters of s are CJK or Thai.
func cjkDominant(s string) bool {
	cjk, other := 0, 0
	for _, r := range s {
		switch {
		case isCJK(r):
			cjk++
		case unicode.IsLetter(r):
			other++
		}
	}
	return cjk > 0 && cjk >= other
}

func runeLen(s string) int { return len([]rune(s)) }

func joinTokens(t []token) string {
	var b strings.Builder
	for _, k := range t {
		b.WriteString(k.text)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func lastRune(s string) rune {
	r := []rune(strings.TrimSpace(s))
	if len(r) == 0 {
		return 0
	}
	return r[len(r)-1]
}

func isSentenceEnd(s string) bool {
	return strings.ContainsRune(".?!…。？！", lastRune(s))
}

func isClauseEnd(s string) bool {
	return strings.ContainsRune(",;:、，；：", lastRune(s))
}

// startsWithClosing reports a token that must not begin a cue.
func startsWithClosing(s string) bool {
	r := []rune(strings.TrimSpace(s))
	return len(r) > 0 && strings.ContainsRune(".,;:!?…。，、？！；：）)」』”’%", r[0])
}

// explode splits tokens containing several CJK runes into one token per rune,
// interpolating times.
func explode(in []token) []token {
	var out []token
	for _, t := range in {
		runes := []rune(t.text)
		hasCJK := false
		for _, r := range runes {
			if isCJK(r) {
				hasCJK = true
				break
			}
		}
		trimmed := strings.TrimSpace(t.text)
		if !hasCJK || runeLen(trimmed) <= 1 {
			out = append(out, t)
			continue
		}
		lead := ""
		if strings.HasPrefix(t.text, " ") {
			lead = " "
		}
		rs := []rune(trimmed)
		n := int64(len(rs))
		for i, r := range rs {
			s := t.start + (t.end-t.start)*int64(i)/n
			e := t.start + (t.end-t.start)*int64(i+1)/n
			txt := string(r)
			if i == 0 {
				txt = lead + txt
			}
			out = append(out, token{start: s, end: e, text: txt})
		}
	}
	return out
}

// segmentTokens makes tokens for a segment: its words, or its text spread
// evenly over its time span.
func segmentTokens(seg rawSegment) []token {
	var toks []token
	for _, w := range seg.Words {
		if strings.TrimSpace(w.Text) == "" {
			continue
		}
		e := max(w.EndMs, w.StartMs)
		toks = append(toks, token{start: w.StartMs, end: e, text: w.Text})
	}
	if len(toks) == 0 {
		text := strings.TrimSpace(seg.Text)
		if text == "" {
			return nil
		}
		var parts []string
		if cjkDominant(text) {
			for _, r := range text {
				if !unicode.IsSpace(r) {
					parts = append(parts, string(r))
				}
			}
		} else {
			parts = strings.Fields(text)
		}
		total := 0
		for _, p := range parts {
			total += runeLen(p)
		}
		end := max(seg.EndMs, seg.StartMs)
		done := 0
		for i, p := range parts {
			s := seg.StartMs + (end-seg.StartMs)*int64(done)/int64(total)
			done += runeLen(p)
			e := seg.StartMs + (end-seg.StartMs)*int64(done)/int64(total)
			txt := p
			if i > 0 && !cjkDominant(text) {
				txt = " " + p
			}
			toks = append(toks, token{start: s, end: e, text: txt})
		}
	}
	return explode(toks)
}

// splitTokens groups tokens into cues' worth of tokens.
func splitTokens(toks []token, lineLen, maxLines int) [][]token {
	capacity := lineLen * max(maxLines, 1)
	n := len(toks)
	fits := func(i, j int) bool {
		if j-i <= 1 {
			return true
		}
		return runeLen(joinTokens(toks[i:j])) <= capacity && toks[j-1].end-toks[i].start <= maxCueMs
	}
	var out [][]token
	for i := 0; i < n; {
		j := i + 1
		for j < n && fits(i, j+1) {
			j++
		}
		cut := -1
		// eager sentence break
		for k := i + 1; k <= j; k++ {
			if isSentenceEnd(toks[k-1].text) && runeLen(joinTokens(toks[i:k])) >= minSentenceRune && (k == n || !startsWithClosing(toks[k].text)) {
				cut = k
				break
			}
		}
		if cut < 0 {
			if j == n {
				cut = n
			} else {
				cut = pickBreak(toks, i, j, capacity)
			}
		}
		out = append(out, toks[i:cut])
		i = cut
	}
	return out
}

// pickBreak chooses where to end a cue that starts at i and can reach j.
func pickBreak(toks []token, i, j, capacity int) int {
	lo := i + 1
	for lo < j && runeLen(joinTokens(toks[i:lo])) < capacity*4/10 {
		lo++
	}
	best, bestClass := j, 0
	for p := lo; p <= j; p++ {
		if p < len(toks) && startsWithClosing(toks[p].text) {
			continue
		}
		class := 0
		switch {
		case p == j:
		case isSentenceEnd(toks[p-1].text):
			class = 3
		case toks[p].start-toks[p-1].end >= pauseBreakMs:
			class = 2
		case isClauseEnd(toks[p-1].text):
			class = 1
		}
		if class > bestClass || (class == bestClass && class > 0) {
			best, bestClass = p, class
		}
	}
	if bestClass == 0 {
		for best > i+1 && best < len(toks) && startsWithClosing(toks[best].text) {
			best--
		}
	}
	return best
}

// wrapLines splits text into at most maxLines lines of about lineLen runes,
// balancing the lines and preferring a break after punctuation.
func wrapLines(text string, lineLen, maxLines int) string {
	text = strings.Join(strings.Fields(text), " ")
	rs := []rune(text)
	if maxLines < 2 || len(rs) <= lineLen {
		return text
	}
	cjk := cjkDominant(text)
	bestPos, bestScore := -1, 1<<30
	for p := 1; p < len(rs); p++ {
		atSpace := rs[p] == ' '
		if !atSpace && !(cjk && !startsWithClosing(string(rs[p]))) {
			continue
		}
		if rs[p-1] == ' ' {
			continue
		}
		a := strings.TrimSpace(string(rs[:p]))
		b := strings.TrimSpace(string(rs[p:]))
		la, lb := runeLen(a), runeLen(b)
		if la == 0 || lb == 0 {
			continue
		}
		score := la - lb
		if score < 0 {
			score = -score
		}
		if over := la - lineLen; over > 0 {
			score += 1000 * over
		}
		if over := lb - lineLen; over > 0 {
			score += 1000 * over
		}
		if strings.ContainsRune(",;:.!?、，。？！…", lastRune(a)) {
			score -= 6
		}
		if score < bestScore {
			bestPos, bestScore = p, score
		}
	}
	if bestPos < 0 {
		return text
	}
	return strings.TrimSpace(string(rs[:bestPos])) + "\n" + strings.TrimSpace(string(rs[bestPos:]))
}

// rewrap keeps text whose lines already fit; otherwise it re-wraps it.
func rewrap(text string, lineLen int) string {
	lines := strings.Split(cueBody(text), "\n")
	ok := len(lines) <= 2
	for _, l := range lines {
		if runeLen(l) > lineLen {
			ok = false
		}
	}
	if ok {
		return strings.Join(lines, "\n")
	}
	return wrapLines(strings.Join(lines, " "), lineLen, 2)
}

// buildCues turns engine segments into subtitle cues.
func buildCues(segs []rawSegment, maxLineChars, maxLines int) []Cue {
	if maxLineChars <= 0 {
		maxLineChars = 42
	}
	if maxLines <= 0 {
		maxLines = 2
	}
	var cues []Cue
	for _, seg := range segs {
		toks := segmentTokens(seg)
		if len(toks) == 0 {
			continue
		}
		lineLen := maxLineChars
		if cjkDominant(joinTokens(toks)) {
			lineLen = min(cjkLineChars, maxLineChars)
		}
		for _, group := range splitTokens(toks, lineLen, maxLines) {
			text := joinTokens(group)
			if text == "" {
				continue
			}
			cues = append(cues, Cue{
				StartMs: group[0].start,
				EndMs:   max(group[len(group)-1].end, group[0].start+1),
				Text:    wrapLines(text, lineLen, maxLines),
			})
		}
	}
	return adjustTimings(cues)
}

// adjustTimings applies the minimum duration and reading speed by extending
// cue ends into the gap before the next cue (keeping gapMs), and removes
// overlaps.
func adjustTimings(cues []Cue) []Cue {
	for i := range cues {
		limit := int64(1) << 60
		if i+1 < len(cues) {
			limit = cues[i+1].StartMs
			if cues[i].EndMs > limit {
				cues[i].EndMs = max(limit, cues[i].StartMs+1)
			}
			limit -= gapMs
		}
		want := cues[i].EndMs
		if want-cues[i].StartMs < minCueMs {
			want = cues[i].StartMs + minCueMs
		}
		chars := runeLen(strings.ReplaceAll(cues[i].Text, "\n", " "))
		if need := int64(float64(chars) / maxCPS * 1000); need > want-cues[i].StartMs {
			want = cues[i].StartMs + min(need, maxCueMs)
		}
		want = min(want, limit)
		if want > cues[i].EndMs {
			cues[i].EndMs = want
		}
	}
	return cues
}
