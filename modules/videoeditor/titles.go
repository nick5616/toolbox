package videoeditor

import (
	"bytes"
	"fmt"
	"sort"

	"toolbox/core/media"
)

// Title styles burned with libass (SPEC.md §B6.2). Sizes follow the frame's
// short side so the same title looks the same in every aspect.
var titleStyleNames = map[string]string{
	"title": "Title", "lower-third": "LowerThird", "caption": "Caption", "label": "Label",
}

// titleStyles are the four ASS styles for a w×h frame.
func titleStyles(w, h int) []media.ASSStyle {
	s := float64(min(w, h))
	marginX := int(float64(w) * 0.06)
	marginV := int(float64(h) * 0.07)
	base := media.ASSStyle{
		Font: media.DefaultFont, Primary: "#ffffff", Secondary: "#ffffff", Outline: "#000000", Back: "#000000",
		BackAlpha: 255, Bold: true, BorderStyle: 1, MarginL: marginX, MarginR: marginX, MarginV: marginV,
	}
	title := base
	title.Name, title.Size, title.OutlineWidth, title.Shadow, title.Alignment = "Title", s*0.085, s*0.006, s*0.003, 5
	caption := base
	caption.Name, caption.Size, caption.OutlineWidth, caption.Shadow, caption.Alignment = "Caption", s*0.052, s*0.005, 0, 2
	lower := base
	lower.Name, lower.Size, lower.Alignment = "LowerThird", s*0.05, 1
	lower.BorderStyle, lower.OutlineWidth, lower.OutlineAlpha, lower.BackAlpha = 3, s*0.012, 100, 100
	label := base
	label.Name, label.Size, label.Alignment = "Label", s*0.038, 7
	label.Bold = false
	label.BorderStyle, label.OutlineWidth, label.OutlineAlpha, label.BackAlpha = 3, s*0.009, 110, 110
	return []media.ASSStyle{title, lower, caption, label}
}

// alignFor is the ASS numpad alignment: centred styles follow the position;
// the boxed lower-third and label hug the left edge.
func alignFor(style, pos string) int {
	left := style == "lower-third" || style == "label"
	switch pos {
	case "top":
		if left {
			return 7
		}
		return 8
	case "center":
		if left {
			return 4
		}
		return 5
	}
	if left {
		return 1
	}
	return 2
}

// tagColor is an ASS inline colour ("&HBBGGRR&").
func tagColor(hex string) string {
	c := media.ASSColor(hex, 0) // &HAABBGGRR
	return "&H" + c[4:] + "&"
}

// buildTitlesASS renders the titles that start before endMs. ok is false
// when there is nothing to burn.
func buildTitlesASS(titles []Title, w, h int, endMs int64) (string, bool) {
	var ev []media.ASSEvent
	for _, t := range titles {
		if t.StartMs >= endMs {
			continue
		}
		stop := min(t.StartMs+t.DurationMs, endMs)
		if stop <= t.StartMs {
			continue
		}
		tags := fmt.Sprintf(`{\an%d`, alignFor(t.Style, t.Position))
		if t.Font != "" {
			tags += `\fn` + t.Font
		}
		if t.Color != "" {
			tags += `\1c` + tagColor(t.Color)
		}
		fade := min(250, (stop-t.StartMs)/4)
		tags += fmt.Sprintf(`\fad(%d,%d)}`, fade, fade)
		ev = append(ev, media.ASSEvent{StartMs: t.StartMs, EndMs: stop, Style: titleStyleNames[t.Style], Text: tags + media.ASSEscape(t.Text)})
	}
	if len(ev) == 0 {
		return "", false
	}
	sort.SliceStable(ev, func(i, j int) bool { return ev[i].StartMs < ev[j].StartMs })
	doc := media.ASSDoc{PlayResX: w, PlayResY: h, Styles: titleStyles(w, h), Events: ev}
	var buf bytes.Buffer
	if _, err := doc.WriteTo(&buf); err != nil {
		return "", false
	}
	return buf.String(), true
}
