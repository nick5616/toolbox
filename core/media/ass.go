package media

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// ASSDoc is an Advanced SubStation Alpha script, rendered by libass through
// FFmpeg's ass filter (Subtitles burn-in, Lyric Video).
type ASSDoc struct {
	PlayResX, PlayResY int
	Styles             []ASSStyle
	Events             []ASSEvent
}

// ASSStyle is one V4+ style. Colours are "#RRGGBB"; alphas are 0 (opaque)
// to 255 (transparent), as in ASS.
type ASSStyle struct {
	Name                              string
	Font                              string
	Size                              float64
	Primary, Secondary, Outline, Back string
	PrimaryAlpha, SecondaryAlpha      int
	OutlineAlpha, BackAlpha           int
	Bold                              bool
	BorderStyle                       int // 1 = outline + shadow, 3 = opaque box
	OutlineWidth, Shadow              float64
	Alignment                         int // numpad layout: 2 bottom centre, 5 middle centre, 8 top centre
	MarginL, MarginR, MarginV         int
}

// ASSEvent is one Dialogue line. Text is raw ASS (already escaped, with
// override tags if any).
type ASSEvent struct {
	Layer          int
	StartMs, EndMs int64
	Style, Text    string
}

// WriteTo writes the script.
func (d ASSDoc) WriteTo(w io.Writer) (int64, error) {
	bw := bufio.NewWriter(w)
	cw := &countWriter{w: bw}
	fmt.Fprintf(cw, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n", d.PlayResX, d.PlayResY)
	fmt.Fprint(cw, "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	for _, s := range d.Styles {
		bold := 0
		if s.Bold {
			bold = -1
		}
		border := s.BorderStyle
		if border == 0 {
			border = 1
		}
		fmt.Fprintf(cw, "Style: %s,%s,%s,%s,%s,%s,%s,%d,0,0,0,100,100,0,0,%d,%s,%s,%d,%d,%d,%d,1\n",
			s.Name, s.Font, num(s.Size),
			ASSColor(s.Primary, s.PrimaryAlpha), ASSColor(s.Secondary, s.SecondaryAlpha),
			ASSColor(s.Outline, s.OutlineAlpha), ASSColor(s.Back, s.BackAlpha),
			bold, border, num(s.OutlineWidth), num(s.Shadow), s.Alignment, s.MarginL, s.MarginR, s.MarginV)
	}
	fmt.Fprint(cw, "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	for _, e := range d.Events {
		fmt.Fprintf(cw, "Dialogue: %d,%s,%s,%s,,0,0,0,,%s\n", e.Layer, ASSTime(e.StartMs), ASSTime(e.EndMs), e.Style, e.Text)
	}
	if err := bw.Flush(); err != nil {
		return cw.n, err
	}
	return cw.n, cw.err
}

type countWriter struct {
	w   io.Writer
	n   int64
	err error
}

func (c *countWriter) Write(p []byte) (int, error) {
	if c.err != nil {
		return 0, c.err
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	c.err = err
	return n, err
}

func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// ASSEscape makes plain text safe as ASS event text: braces and backslashes
// can't start override tags, and newlines become \N.
func ASSEscape(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var b strings.Builder
	for _, r := range text {
		switch r {
		case '\\':
			b.WriteString("＼") // fullwidth reverse solidus: never starts a tag
		case '{':
			b.WriteString("｛")
		case '}':
			b.WriteString("｝")
		case '\n':
			b.WriteString(`\N`)
		case '\r':
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ASSColor turns "#rrggbb" plus an alpha (0 opaque … 255 transparent) into
// &HAABBGGRR. Invalid colours become white.
func ASSColor(hex string, alpha int) string {
	r, g, b, ok := ParseHexColor(hex)
	if !ok {
		r, g, b = 255, 255, 255
	}
	alpha = max(0, min(255, alpha))
	return fmt.Sprintf("&H%02X%02X%02X%02X", alpha, b, g, r)
}

// ParseHexColor parses "#rrggbb".
func ParseHexColor(hex string) (r, g, b uint8, ok bool) {
	if len(hex) != 7 || hex[0] != '#' {
		return 0, 0, 0, false
	}
	v, err := strconv.ParseUint(hex[1:], 16, 32)
	if err != nil {
		return 0, 0, 0, false
	}
	return uint8(v >> 16), uint8(v >> 8), uint8(v), true
}

// ASSTime formats ms as H:MM:SS.cc (centiseconds, rounded down).
func ASSTime(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	cs := ms / 10
	return fmt.Sprintf("%d:%02d:%02d.%02d", cs/360000, cs/6000%60, cs/100%60, cs%100)
}
