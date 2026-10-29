package lyricvideo

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"toolbox/core/media"
)

// layout is where everything sits on the canvas (pixels).
type layout struct {
	W, H           int
	Base, Long     float64 // font sizes: normal and for lines over 30 characters
	BoxX0, BoxX1   int     // the text column
	CX, CY         int     // centre of the current line
	Cover          bool    // a sharp cover is drawn
	CoverS         int     // its side
	CoverX, CoverY int
	VisY, VisH     int // the visualiser strip
}

// canvasSize returns the output size for an aspect and the short side.
func canvasSize(aspect string, height int) (w, h int) {
	if height != 720 {
		height = 1080
	}
	switch aspect {
	case "9:16":
		return height, height * 16 / 9
	case "1:1":
		return height, height
	default:
		return height * 16 / 9, height
	}
}

// computeLayout places the cover, text column and visualiser (SPEC.md §7.3).
func computeLayout(o Options, w, h int) layout {
	short := min(w, h)
	l := layout{W: w, H: h, Base: 0.065 * float64(short), Long: 0.055 * float64(short)}
	l.BoxX0, l.BoxX1 = int(0.06*float64(w)), w-int(0.06*float64(w))
	l.CX, l.CY = w/2, h/2
	l.VisH = h * 18 / 100
	l.VisY = h - l.VisH
	lower := o.Look.Position == "lower"
	if o.Look.Background == "cover" {
		l.Cover = true
		if w > h { // landscape: cover on the left third, text in the right two-thirds
			l.CoverS = min(h*60/100, w*3/10)
			l.CoverX = (w/3 - l.CoverS) / 2
			l.CoverY = (h - l.CoverS) / 2
			l.BoxX0 = w / 3
			l.CX = (l.BoxX0 + l.BoxX1) / 2
			l.CY = h / 2
		} else { // portrait and square: cover on top, text below
			l.CoverS = w * 45 / 100
			l.CoverX = (w - l.CoverS) / 2
			l.CoverY = h * 6 / 100
			bottom := l.CoverY + l.CoverS
			l.CY = bottom + (h-bottom)/2
		}
	}
	if lower {
		l.CY = h * 86 / 100
		if l.Cover && w <= h {
			l.CY = max(l.CY, l.CoverY+l.CoverS+int(l.Base*2))
		}
		l.VisY = max(0, l.CY-int(l.Base*2.2)-l.VisH)
	}
	return l
}

func (l layout) boxWidth() int { return l.BoxX1 - l.BoxX0 }

// wrapLines estimates how many rows text takes at size.
func (l layout) wrapLines(text string, size float64) int {
	width := float64(utf8.RuneCountInString(text)) * size * 0.55
	return max(1, int(width/float64(l.boxWidth())+0.999))
}

func (l layout) sizeFor(text string) float64 {
	if utf8.RuneCountInString(text) > 30 {
		return l.Long
	}
	return l.Base
}

func fmtSize(v float64) string { return fmt.Sprintf("%.0f", v) }

// buildASS makes the script for lines. Times shift by -winStart and are cut
// to [winStart, winEnd) (winEnd <= 0 = no end); lines ending outside are
// dropped. Look fields must already be normalised.
func buildASS(o Options, l layout, winStart, winEnd int64) media.ASSDoc {
	look := o.Look
	style := func(name string, size float64, c string, alpha int, secondary string) media.ASSStyle {
		return media.ASSStyle{
			Name: name, Font: look.Font, Size: size,
			Primary: c, Secondary: secondary, Outline: "#000000", Back: "#000000",
			PrimaryAlpha: alpha, SecondaryAlpha: alpha, BackAlpha: 255,
			Bold: true, BorderStyle: 1, OutlineWidth: float64(int(size*0.03*10+0.5)) / 10,
			Alignment: 5, MarginL: l.BoxX0, MarginR: l.W - l.BoxX1, MarginV: 0,
		}
	}
	main := style("Lyric", l.Base, look.TextColor, 0, look.TextColor)
	if look.Karaoke {
		main.Primary = look.HighlightColor
	}
	doc := media.ASSDoc{
		PlayResX: l.W, PlayResY: l.H,
		Styles: []media.ASSStyle{
			main,
			style("Next", l.Base*0.8, look.TextColor, 115, look.TextColor),
			style("Title", l.Base*1.3, look.TextColor, 0, look.TextColor),
			style("Artist", l.Base*0.8, look.TextColor, 40, look.TextColor),
		},
	}
	if winEnd <= 0 {
		winEnd = 1 << 60
	}
	add := func(s, e int64, style, text string) {
		if e <= winStart || s >= winEnd || e <= s {
			return
		}
		s, e = max(s, winStart), min(e, winEnd)
		doc.Events = append(doc.Events, media.ASSEvent{StartMs: s - winStart, EndMs: e - winStart, Style: style, Text: text})
	}
	pos := func(x, y int) string { return fmt.Sprintf(`\an5\pos(%d,%d)`, x, y) }

	lines := o.Lines
	// Title card: from 0 to min(3 s, first line - 200 ms).
	if look.TitleCard && (look.Title != "" || look.Artist != "") && len(lines) > 0 {
		if end := min(3000, lines[0].StartMs-200); end > 0 {
			fade := `\fad(300,300)`
			ty := l.CY
			if look.Artist != "" && look.Title != "" {
				ty = l.CY - int(l.Base*0.6)
			}
			if look.Title != "" {
				add(0, end, "Title", fmt.Sprintf(`{%s%s}%s`, pos(l.CX, ty), fade, media.ASSEscape(look.Title)))
			}
			if look.Artist != "" {
				ay := l.CY
				if look.Title != "" {
					ay = l.CY + int(l.Base*1.0)
				}
				add(0, end, "Artist", fmt.Sprintf(`{%s%s}%s`, pos(l.CX, ay), fade, media.ASSEscape(look.Artist)))
			}
		}
	}

	for i, ln := range lines {
		s, e := ln.StartMs, ln.EndMs
		if i+1 < len(lines) {
			e = min(e, lines[i+1].StartMs)
		}
		if e <= s {
			e = s + 300
		}
		if strings.TrimSpace(ln.Text) == "" {
			continue
		}
		size := l.sizeFor(ln.Text)
		var tag strings.Builder
		tag.WriteString(pos(l.CX, l.CY))
		if size != l.Base {
			fmt.Fprintf(&tag, `\fs%s`, fmtSize(size))
		}
		var body string
		if look.Karaoke {
			words := ln.Words
			if len(words) == 0 {
				cp := ln
				cp.EndMs = e
				spreadWords(&cp)
				words = cp.Words
			}
			body = karaokeText(words, max(s, winStart))
		} else {
			tag.WriteString(`\fad(150,150)`)
			body = media.ASSEscape(ln.Text)
		}
		add(s, e, "Lyric", fmt.Sprintf("{%s}%s", tag.String(), body))

		if look.ShowNext && i+1 < len(lines) && strings.TrimSpace(lines[i+1].Text) != "" {
			nx := lines[i+1].Text
			nsize := l.sizeFor(nx) * 0.8
			curH := float64(l.wrapLines(ln.Text, size)) * size * 1.2
			ny := l.CY + int(curH/2+nsize*0.9)
			ntag := pos(l.CX, ny)
			if nsize != l.Base*0.8 {
				ntag += fmt.Sprintf(`\fs%s`, fmtSize(nsize))
			}
			add(s, e, "Next", fmt.Sprintf("{%s}%s", ntag, media.ASSEscape(nx)))
		}
	}
	return doc
}

// karaokeText writes {\kf<cs>}word pairs. Each word's duration runs from the
// previous word's end (the first from the line's visible start) to its own
// end, so the fill sweeps without pauses; cumulative rounding keeps it in
// sync.
func karaokeText(words []LyricWord, from int64) string {
	var b strings.Builder
	t := from
	prevCS := int64(0)
	for i, w := range words {
		end := max(w.EndMs, t)
		cum := (end - from + 5) / 10
		fmt.Fprintf(&b, `{\kf%d}`, max(0, cum-prevCS))
		prevCS = max(prevCS, cum)
		t = end
		b.WriteString(media.ASSEscape(w.Text))
		if i+1 < len(words) && needSpace(w.Text, words[i+1].Text) {
			b.WriteByte(' ')
		}
	}
	return b.String()
}
