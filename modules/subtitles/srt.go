package subtitles

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// maxSubtitleFileBytes bounds what Load reads.
const maxSubtitleFileBytes = 20 << 20

func clockParts(ms int64) (h, m, s, milli int64) {
	if ms < 0 {
		ms = 0
	}
	return ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000
}

func srtTime(ms int64) string {
	h, m, s, f := clockParts(ms)
	return fmt.Sprintf("%02d:%02d:%02d,%03d", h, m, s, f)
}

func vttTime(ms int64) string {
	h, m, s, f := clockParts(ms)
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, f)
}

func normalizeNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

// cueBody normalises cue text for a file: LF newlines, no blank lines (a
// blank line would end the cue).
func cueBody(text string) string {
	lines := strings.Split(normalizeNewlines(text), "\n")
	out := lines[:0]
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			out = append(out, strings.TrimRight(l, " \t"))
		}
	}
	return strings.Join(out, "\n")
}

// formatSRT renders cues as SubRip (LF line endings).
func formatSRT(cues []Cue) string {
	var b strings.Builder
	for i, c := range cues {
		fmt.Fprintf(&b, "%d\n%s --> %s\n%s\n\n", i+1, srtTime(c.StartMs), srtTime(c.EndMs), cueBody(c.Text))
	}
	return b.String()
}

var vttEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// formatVTT renders cues as WebVTT.
func formatVTT(cues []Cue) string {
	var b strings.Builder
	b.WriteString("WEBVTT\n\n")
	for _, c := range cues {
		fmt.Fprintf(&b, "%s --> %s\n%s\n\n", vttTime(c.StartMs), vttTime(c.EndMs), vttEscaper.Replace(cueBody(c.Text)))
	}
	return b.String()
}

var (
	timeRe = regexp.MustCompile(`^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$`)
	tagRe  = regexp.MustCompile(`</?[A-Za-z][^>]*>|<\d+:\d{2}[:.\d]*>`)
	vttEnt = strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&nbsp;", " ", "&lrm;", "", "&rlm;", "")
)

// parseTimestamp parses "H:MM:SS,mmm" and "MM:SS.mmm"; hours may be any length.
func parseTimestamp(s string) (int64, bool) {
	m := timeRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	var h int64
	if m[1] != "" {
		v, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			return 0, false
		}
		h = v
	}
	mi, _ := strconv.ParseInt(m[2], 10, 64)
	se, _ := strconv.ParseInt(m[3], 10, 64)
	frac := m[4]
	for len(frac) < 3 {
		frac += "0"
	}
	ms, _ := strconv.ParseInt(frac, 10, 64)
	return ((h*60+mi)*60+se)*1000 + ms, true
}

// cp1252High maps bytes 0x80–0x9F of Windows-1252 to runes (undefined bytes
// keep the C1 control of the same value, like browsers do).
var cp1252High = [32]rune{
	0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
	0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
}

// decodeText turns file bytes into a string: UTF-8 (BOM stripped), else
// Windows-1252.
func decodeText(b []byte) string {
	b = []byte(strings.TrimPrefix(string(b), bomStr))
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for _, c := range b {
		if c >= 0x80 && c <= 0x9F {
			sb.WriteRune(cp1252High[c-0x80])
		} else {
			sb.WriteRune(rune(c)) // ASCII and 0xA0–0xFF map 1:1 to Latin-1
		}
	}
	return sb.String()
}

// parseCues parses SubRip or WebVTT text.
func parseCues(text string) []Cue {
	text = normalizeNewlines(strings.TrimPrefix(text, bomStr))
	vtt := strings.HasPrefix(text, "WEBVTT")
	cues := []Cue{}
	for _, block := range strings.Split(text, "\n\n") {
		lines := strings.Split(strings.Trim(block, "\n"), "\n")
		at := -1
		for i, l := range lines {
			if strings.Contains(l, "-->") {
				at = i
				break
			}
		}
		if at < 0 {
			continue // header, NOTE, STYLE, REGION, or junk
		}
		a, b, _ := strings.Cut(lines[at], "-->")
		start, ok1 := parseTimestamp(a)
		endField := strings.Fields(b) // cue settings follow the end time
		if len(endField) == 0 {
			continue
		}
		end, ok2 := parseTimestamp(endField[0])
		if !ok1 || !ok2 || end <= start {
			continue
		}
		body := strings.Join(lines[at+1:], "\n")
		if vtt {
			body = vttEnt.Replace(tagRe.ReplaceAllString(body, ""))
		}
		body = cueBody(body)
		if body == "" {
			continue
		}
		cues = append(cues, Cue{StartMs: start, EndMs: end, Text: body})
	}
	sort.SliceStable(cues, func(i, j int) bool { return cues[i].StartMs < cues[j].StartMs })
	return cues
}

func load(path string) ([]Cue, error) {
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".srt" && ext != ".vtt" {
		return nil, core.ValidationError("Choose an .srt or .vtt file", map[string]string{"path": "Choose an .srt or .vtt file"})
	}
	st, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, core.Errorf(core.CodeNotFound, "That subtitle file doesn't exist")
		}
		return nil, fmt.Errorf("stat subtitle file: %w", err)
	}
	if st.Size() > maxSubtitleFileBytes {
		return nil, core.ValidationError("That subtitle file is too large", nil)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read subtitle file: %w", err)
	}
	return parseCues(decodeText(b)), nil
}

// bomStr is the UTF-8 byte order mark.
const bomStr = "\uFEFF"
