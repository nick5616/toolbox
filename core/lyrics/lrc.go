package lyrics

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// bom is the UTF-8 byte order mark some text files start with.
const bom = "\xef\xbb\xbf"

var (
	lrcLineTag = regexp.MustCompile(`^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]`)
	lrcMeta    = regexp.MustCompile(`^\[([A-Za-z#]+):(.*)\]\s*$`)
	lrcWordTag = regexp.MustCompile(`<(\d+):(\d{1,2})(?:[.:](\d{1,3}))?>`)
)

// lrcTime converts the captured minutes, seconds and fraction to ms. The
// fraction is centiseconds with two digits, milliseconds with three.
func lrcTime(min, sec, frac string) int64 {
	m, _ := strconv.ParseInt(min, 10, 64)
	s, _ := strconv.ParseInt(sec, 10, 64)
	var f int64
	switch len(frac) {
	case 1:
		f, _ = strconv.ParseInt(frac, 10, 64)
		f *= 100
	case 2:
		f, _ = strconv.ParseInt(frac, 10, 64)
		f *= 10
	case 3:
		f, _ = strconv.ParseInt(frac, 10, 64)
	}
	return (m*60+s)*1000 + f
}

// estimateLineMs is how long a line without an end time lasts: its
// characters at ~12 per second, kept within 1.5-8 s.
func estimateLineMs(text string) int64 {
	d := int64(utf8.RuneCountInString(text)) * 80
	return max(1500, min(8000, d))
}

// ParseLRC parses (enhanced) LRC text. Repeated line tags duplicate the
// line, [offset:+-ms] shifts every time earlier by that many ms (the LRC
// convention: positive = lyrics appear sooner), and <mm:ss.xx> tags give
// word times. Metadata tags are ignored.
func ParseLRC(text string) []Line {
	type raw struct {
		start int64
		body  string
	}
	var offset int64
	var raws []raw
	for _, ln := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		ln = strings.TrimSpace(strings.TrimPrefix(ln, bom))
		if ln == "" {
			continue
		}
		var starts []int64
		rest := ln
		for {
			m := lrcLineTag.FindStringSubmatch(rest)
			if m == nil {
				break
			}
			starts = append(starts, lrcTime(m[1], m[2], m[3]))
			rest = rest[len(m[0]):]
		}
		if len(starts) == 0 {
			if m := lrcMeta.FindStringSubmatch(ln); m != nil && strings.EqualFold(m[1], "offset") {
				if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(m[2], "+")), 10, 64); err == nil {
					offset = v
				}
			}
			continue
		}
		for _, s := range starts {
			raws = append(raws, raw{s, rest})
		}
	}
	sort.SliceStable(raws, func(i, j int) bool { return raws[i].start < raws[j].start })
	lines := make([]Line, 0, len(raws))
	for i, r := range raws {
		nextStart := int64(-1)
		if i+1 < len(raws) {
			nextStart = raws[i+1].start
		}
		ln := parseLRCBody(r.start, nextStart, r.body)
		if ln.Text == "" {
			continue // a blank timestamp line only ends the previous line
		}
		lines = append(lines, ln)
	}
	if offset != 0 {
		for i := range lines {
			shiftLine(&lines[i], -offset)
		}
	}
	clampOverlaps(lines)
	return lines
}

func parseLRCBody(start, nextStart int64, body string) Line {
	ln := Line{StartMs: start, Words: []Word{}}
	tags := lrcWordTag.FindAllStringSubmatchIndex(body, -1)
	if len(tags) == 0 {
		ln.Text = strings.TrimSpace(body)
		ln.EndMs = lineEndFor(start, nextStart, ln.Text)
		SpreadWords(&ln)
		return ln
	}
	type seg struct {
		t    int64
		text string
	}
	var segs []seg
	if pre := strings.TrimSpace(body[:tags[0][0]]); pre != "" {
		segs = append(segs, seg{start, pre})
	}
	for i, ix := range tags {
		t := lrcTime(body[ix[2]:ix[3]], body[ix[4]:ix[5]], sub(body, ix[6], ix[7]))
		end := len(body)
		if i+1 < len(tags) {
			end = tags[i+1][0]
		}
		segs = append(segs, seg{t, body[ix[1]:end]})
	}
	var texts []string
	for _, s := range segs {
		if w := strings.TrimSpace(s.text); w != "" {
			texts = append(texts, w)
		}
	}
	ln.Text = strings.Join(texts, " ")
	last := segs[len(segs)-1].t
	ln.EndMs = lineEndFor(start, nextStart, ln.Text)
	if ln.EndMs <= last {
		ln.EndMs = last + 500
	}
	for i, s := range segs {
		w := strings.TrimSpace(s.text)
		if w == "" {
			continue
		}
		end := ln.EndMs
		if i+1 < len(segs) {
			end = segs[i+1].t
		}
		ln.Words = append(ln.Words, Word{StartMs: s.t, EndMs: max(end, s.t), Text: w})
	}
	if len(ln.Words) > 0 {
		ln.StartMs = ln.Words[0].StartMs
	}
	return ln
}

func sub(s string, a, b int) string {
	if a < 0 || b < 0 {
		return ""
	}
	return s[a:b]
}

func lineEndFor(start, nextStart int64, text string) int64 {
	est := start + estimateLineMs(text)
	if nextStart >= 0 && nextStart < est {
		return max(nextStart, start)
	}
	return est
}

func shiftLine(l *Line, d int64) {
	l.StartMs = max(0, l.StartMs+d)
	l.EndMs = max(l.StartMs, l.EndMs+d)
	for i := range l.Words {
		l.Words[i].StartMs = max(0, l.Words[i].StartMs+d)
		l.Words[i].EndMs = max(l.Words[i].StartMs, l.Words[i].EndMs+d)
	}
}

// clampOverlaps makes every line end no later than the next one starts.
func clampOverlaps(lines []Line) {
	for i := 0; i+1 < len(lines); i++ {
		if lines[i].EndMs > lines[i+1].StartMs {
			lines[i].EndMs = max(lines[i+1].StartMs, lines[i].StartMs)
		}
		for j := range lines[i].Words {
			w := &lines[i].Words[j]
			w.EndMs = min(w.EndMs, lines[i].EndMs)
			w.StartMs = min(w.StartMs, w.EndMs)
		}
	}
}

var (
	cueTime = regexp.MustCompile(`^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})`)
	cueTag  = regexp.MustCompile(`<[^>]*>|\{\\[^}]*\}`)
)

func cueMs(h, m, s, f string) int64 {
	hh, _ := strconv.ParseInt(h, 10, 64)
	mm, _ := strconv.ParseInt(m, 10, 64)
	ss, _ := strconv.ParseInt(s, 10, 64)
	ff, _ := strconv.ParseInt((f + "00")[:3], 10, 64)
	return ((hh*60+mm)*60+ss)*1000 + ff
}

// ParseCues parses SubRip or WebVTT text into lines (each cue is a line;
// its text lines are joined by a space).
func ParseCues(text string) []Line {
	lines := []Line{}
	src := strings.Split(strings.ReplaceAll(strings.TrimPrefix(text, bom), "\r\n", "\n"), "\n")
	for i := 0; i < len(src); i++ {
		m := cueTime.FindStringSubmatch(src[i])
		if m == nil {
			continue
		}
		var parts []string
		for i+1 < len(src) && strings.TrimSpace(src[i+1]) != "" {
			i++
			if t := strings.TrimSpace(cueTag.ReplaceAllString(src[i], "")); t != "" {
				parts = append(parts, t)
			}
		}
		if len(parts) == 0 {
			continue
		}
		ln := Line{
			StartMs: cueMs(m[1], m[2], m[3], m[4]), EndMs: cueMs(m[5], m[6], m[7], m[8]),
			Text: strings.Join(parts, " "), Words: []Word{},
		}
		ln.EndMs = max(ln.EndMs, ln.StartMs)
		SpreadWords(&ln)
		lines = append(lines, ln)
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].StartMs < lines[j].StartMs })
	clampOverlaps(lines)
	return lines
}

func lrcStamp(ms int64, open, close string) string {
	ms = max(0, ms)
	cs := ms / 10
	return fmt.Sprintf("%s%02d:%02d.%02d%s", open, cs/6000, cs/100%60, cs%100, close)
}

// FormatLRC writes an enhanced LRC: a [mm:ss.xx] tag per line and, for lines
// with word times, a <mm:ss.xx> tag before each word. title and artist, when
// set, become [ti:] and [ar:] headers.
func FormatLRC(lines []Line, title, artist string) string {
	var b strings.Builder
	clean := func(s string) string { return strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(s)) }
	if t := clean(title); t != "" {
		fmt.Fprintf(&b, "[ti:%s]\n", t)
	}
	if a := clean(artist); a != "" {
		fmt.Fprintf(&b, "[ar:%s]\n", a)
	}
	for _, l := range lines {
		b.WriteString(lrcStamp(l.StartMs, "[", "]"))
		if len(l.Words) == 0 {
			b.WriteString(clean(l.Text))
		} else {
			for i, w := range l.Words {
				if i > 0 {
					b.WriteByte(' ')
				}
				b.WriteString(lrcStamp(w.StartMs, "<", ">"))
				b.WriteString(clean(w.Text))
			}
		}
		b.WriteByte('\n')
	}
	return b.String()
}
