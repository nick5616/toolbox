package doctext

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	reTag      = regexp.MustCompile(`<[^>]*>`)
	reASSBlock = regexp.MustCompile(`\{[^}]*\}`)
	reLRC      = regexp.MustCompile(`^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]`)
)

// parseSubs reads cues from srt, vtt, lrc or ass text. Each Chunk is one cue:
// Pos = start ms, EndPos = end ms.
func parseSubs(ext, text string) []Chunk {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	switch ext {
	case ".lrc":
		return parseLRC(text)
	case ".ass":
		return parseASS(text)
	}
	return parseSRTVTT(text)
}

// parseClock reads "h:mm:ss,mmm", "hh:mm:ss.mmm" or "mm:ss.mmm" as ms.
func parseClock(s string) (int64, bool) {
	s = strings.TrimSpace(strings.Replace(s, ",", ".", 1))
	frac := ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		s, frac = s[:i], s[i+1:]
	}
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	var secs int64
	for _, p := range parts {
		n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64)
		if err != nil || n < 0 {
			return 0, false
		}
		secs = secs*60 + n
	}
	return secs*1000 + fracMs(frac), true
}

// fracMs turns decimal digits after the point into ms ("5" = 500, "50" = 500, "05" = 50).
func fracMs(frac string) int64 {
	if frac == "" {
		return 0
	}
	for len(frac) < 3 {
		frac += "0"
	}
	n, _ := strconv.ParseInt(frac[:3], 10, 64)
	return n
}

func parseSRTVTT(text string) []Chunk {
	out := []Chunk{}
	for _, block := range strings.Split(text, "\n\n") {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		at := -1
		for i, l := range lines {
			if strings.Contains(l, "-->") {
				at = i
				break
			}
		}
		if at < 0 {
			continue
		}
		f := strings.Fields(strings.ReplaceAll(lines[at], "-->", " --> "))
		if len(f) < 3 {
			continue
		}
		start, ok1 := parseClock(f[0])
		end, ok2 := parseClock(f[2])
		if !ok1 || !ok2 {
			continue
		}
		var parts []string
		for _, l := range lines[at+1:] {
			l = cleanCue(reTag.ReplaceAllString(l, ""))
			if l != "" {
				parts = append(parts, l)
			}
		}
		if len(parts) == 0 {
			continue
		}
		out = append(out, Chunk{Pos: start, EndPos: end, Text: strings.Join(parts, "\n")})
	}
	return out
}

// cleanCue unescapes the few HTML entities subtitle files use and trims.
func cleanCue(s string) string {
	s = strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&nbsp;", " ", "&quot;", `"`).Replace(s)
	return strings.TrimSpace(s)
}

func parseLRC(text string) []Chunk {
	type line struct {
		ms   int64
		text string
	}
	var lines []line
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		var stamps []int64
		for {
			m := reLRC.FindStringSubmatch(l)
			if m == nil {
				break
			}
			mins, _ := strconv.ParseInt(m[1], 10, 64)
			secs, _ := strconv.ParseInt(m[2], 10, 64)
			stamps = append(stamps, (mins*60+secs)*1000+fracMs(m[3]))
			l = strings.TrimSpace(l[len(m[0]):])
		}
		if len(stamps) == 0 {
			continue
		}
		l = cleanCue(reTag.ReplaceAllString(l, ""))
		if l == "" {
			continue
		}
		for _, ms := range stamps {
			lines = append(lines, line{ms, l})
		}
	}
	// Stable sort by time (stamps repeated for a chorus can be out of order).
	for i := 1; i < len(lines); i++ {
		for j := i; j > 0 && lines[j].ms < lines[j-1].ms; j-- {
			lines[j], lines[j-1] = lines[j-1], lines[j]
		}
	}
	out := make([]Chunk, 0, len(lines))
	for i, l := range lines {
		end := l.ms + 5000
		if i+1 < len(lines) && lines[i+1].ms > l.ms {
			end = lines[i+1].ms
		}
		out = append(out, Chunk{Pos: l.ms, EndPos: end, Text: l.text})
	}
	return out
}

func parseASS(text string) []Chunk {
	out := []Chunk{}
	iStart, iEnd, iText := 1, 2, 9
	inEvents := false
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "[") && strings.HasSuffix(l, "]") {
			inEvents = strings.EqualFold(l, "[Events]")
			continue
		}
		if !inEvents {
			continue
		}
		switch {
		case strings.HasPrefix(l, "Format:"):
			cols := strings.Split(strings.TrimPrefix(l, "Format:"), ",")
			for i, c := range cols {
				switch strings.ToLower(strings.TrimSpace(c)) {
				case "start":
					iStart = i
				case "end":
					iEnd = i
				case "text":
					iText = i
				}
			}
		case strings.HasPrefix(l, "Dialogue:"):
			body := strings.TrimSpace(strings.TrimPrefix(l, "Dialogue:"))
			f := strings.SplitN(body, ",", iText+1)
			if len(f) <= iText || iStart >= len(f) || iEnd >= len(f) {
				continue
			}
			start, ok1 := parseClock(f[iStart])
			end, ok2 := parseClock(f[iEnd])
			if !ok1 || !ok2 {
				continue
			}
			t := reASSBlock.ReplaceAllString(f[iText], "")
			t = strings.NewReplacer(`\N`, "\n", `\n`, "\n", `\h`, " ").Replace(t)
			t = cleanCue(t)
			if t == "" {
				continue
			}
			out = append(out, Chunk{Pos: start, EndPos: end, Text: t})
		}
	}
	return out
}
