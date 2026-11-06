package imagebatch

import (
	"fmt"
	"image"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"

	"toolbox/core"
)

// Layout says how a source picture of w×h becomes the output canvas: take
// Crop from the source, scale it to Content, and place Content at Offset on a
// Canvas-sized canvas (the rest is background).
type Layout struct {
	Crop    image.Rectangle // in source pixels
	Content image.Point     // scaled size of the crop
	Canvas  image.Point
	Offset  image.Point
}

// ParseAspect parses "W:H".
func ParseAspect(s string) (float64, bool) {
	a, b, ok := strings.Cut(s, ":")
	if !ok {
		return 0, false
	}
	w, err1 := strconv.Atoi(a)
	h, err2 := strconv.Atoi(b)
	if err1 != nil || err2 != nil || w <= 0 || h <= 0 || w > 100 || h > 100 {
		return 0, false
	}
	return float64(w) / float64(h), true
}

// cropToAspect is the largest centred rectangle of w×h with the aspect ratio ar.
func cropToAspect(w, h int, ar float64) image.Rectangle {
	cw, ch := w, h
	if float64(w)/float64(h) > ar {
		cw = max(1, int(math.Round(float64(h)*ar)))
	} else {
		ch = max(1, int(math.Round(float64(w)/ar)))
	}
	x, y := (w-cw)/2, (h-ch)/2
	return image.Rect(x, y, x+cw, y+ch)
}

// padToAspect is the smallest canvas of aspect ar that holds w×h.
func padToAspect(w, h int, ar float64) image.Point {
	cw, ch := w, h
	if float64(w)/float64(h) < ar {
		cw = max(w, int(math.Round(float64(h)*ar)))
	} else {
		ch = max(h, int(math.Round(float64(w)/ar)))
	}
	return image.Pt(cw, ch)
}

// PlanLayout computes the Layout of a w×h source for the options.
func PlanLayout(w, h int, o Options) Layout {
	full := image.Rect(0, 0, w, h)
	l := Layout{Crop: full, Content: image.Pt(w, h), Canvas: image.Pt(w, h)}
	center := func() { l.Offset = image.Pt((l.Canvas.X-l.Content.X)/2, (l.Canvas.Y-l.Content.Y)/2) }

	if o.Resize == ResizeExact {
		tw, th := o.Width, o.Height
		l.Canvas = image.Pt(tw, th)
		if o.Fit == FitPad {
			s := math.Min(float64(tw)/float64(w), float64(th)/float64(h))
			l.Content = image.Pt(max(1, min(tw, int(math.Round(float64(w)*s)))), max(1, min(th, int(math.Round(float64(h)*s)))))
			center()
		} else {
			l.Crop = cropToAspect(w, h, float64(tw)/float64(th))
			l.Content = l.Canvas
		}
		return l
	}
	if ar, ok := ParseAspect(o.Aspect); ok && o.Aspect != "" {
		if o.Fit == FitPad {
			l.Canvas = padToAspect(w, h, ar)
			center()
		} else {
			l.Crop = cropToAspect(w, h, ar)
			l.Content = image.Pt(l.Crop.Dx(), l.Crop.Dy())
			l.Canvas = l.Content
		}
	}
	if o.Resize == ResizeLongSide && o.LongSide > 0 {
		long := max(l.Canvas.X, l.Canvas.Y)
		s := float64(o.LongSide) / float64(long)
		if o.NoEnlarge && s > 1 {
			s = 1
		}
		if s != 1 {
			l.Canvas = scalePt(l.Canvas, s)
			l.Content = scalePt(l.Content, s)
			l.Content = image.Pt(min(l.Content.X, l.Canvas.X), min(l.Content.Y, l.Canvas.Y))
			center()
		}
	}
	return l
}

func scalePt(p image.Point, s float64) image.Point {
	return image.Pt(max(1, int(math.Round(float64(p.X)*s))), max(1, int(math.Round(float64(p.Y)*s))))
}

// Scaled shrinks the layout by s (≤ 1) for previews.
func (l Layout) Scaled(s float64) Layout {
	if s >= 1 {
		return l
	}
	l.Canvas = scalePt(l.Canvas, s)
	l.Content = scalePt(l.Content, s)
	l.Content = image.Pt(min(l.Content.X, l.Canvas.X), min(l.Content.Y, l.Canvas.Y))
	l.Offset = image.Pt((l.Canvas.X-l.Content.X)/2, (l.Canvas.Y-l.Content.Y)/2)
	return l
}

// marginFor is the gap between a watermark and the edge: 2% of the short side.
func marginFor(canvas image.Point) int {
	return max(2, int(math.Round(float64(min(canvas.X, canvas.Y))*0.02)))
}

// PlaceWatermark is the top-left of a wmW×wmH mark in the given corner of
// the canvas, kept inside it.
func PlaceWatermark(canvas image.Point, wmW, wmH int, c Corner) image.Point {
	m := marginFor(canvas)
	x, y := m, m
	switch c {
	case CornerTopRight:
		x = canvas.X - wmW - m
	case CornerBottomLeft:
		y = canvas.Y - wmH - m
	case CornerBottomRight:
		x, y = canvas.X-wmW-m, canvas.Y-wmH-m
	case CornerCenter:
		x, y = (canvas.X-wmW)/2, (canvas.Y-wmH)/2
	}
	return image.Pt(max(0, x), max(0, y))
}

// assAlignment is the numpad alignment of a corner.
func assAlignment(c Corner) int {
	switch c {
	case CornerTopLeft:
		return 7
	case CornerTopRight:
		return 9
	case CornerBottomLeft:
		return 1
	case CornerCenter:
		return 5
	}
	return 3
}

// ExpandName fills a name pattern. n is 1-based, padded to the width of
// total; the result has no path separators or characters Windows rejects
// and is never empty.
func ExpandName(pattern, name string, n, total int, now time.Time) string {
	if strings.TrimSpace(pattern) == "" {
		pattern = "{name}"
	}
	width := len(strconv.Itoa(max(total, 1)))
	num := fmt.Sprintf("%0*d", width, n)
	out, _ := core.ExpandVars(pattern, map[string]string{"name": name, "n": num, "date": now.Format("2006-01-02")})
	out = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, out)
	out = strings.TrimFunc(out, func(r rune) bool { return unicode.IsSpace(r) || r == '.' })
	if out == "" {
		out = name
	}
	if len(out) > 180 {
		cut := 180
		for cut > 0 && !isRuneStart(out[cut]) {
			cut--
		}
		out = out[:cut]
	}
	return out
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

// Validate checks the options.
func (o Options) Validate() error {
	fe := func(msg, field string) error { return core.ValidationError(msg, map[string]string{field: msg}) }
	switch o.Resize {
	case ResizeKeep:
	case ResizeLongSide:
		if o.LongSide < MinSide || o.LongSide > MaxSide {
			return fe("The long side must be between 16 and 20,000 pixels", "longSide")
		}
	case ResizeExact:
		if o.Width < 1 || o.Width > MaxSide {
			return fe("The width must be between 1 and 20,000 pixels", "width")
		}
		if o.Height < 1 || o.Height > MaxSide {
			return fe("The height must be between 1 and 20,000 pixels", "height")
		}
	default:
		return fe("Choose how to resize", "resize")
	}
	if o.Aspect != "" {
		ok := false
		for _, a := range Aspects() {
			ok = ok || a == o.Aspect
		}
		if !ok {
			return fe("Choose a shape from the list", "aspect")
		}
	}
	if o.Fit != FitCrop && o.Fit != FitPad {
		return fe("Choose crop or pad", "fit")
	}
	if o.Background != "transparent" {
		if _, _, _, ok := parseColor(o.Background); !ok {
			return fe("Use a colour like #ffffff", "background")
		}
	}
	switch o.Format {
	case FormatSame, FormatJPG, FormatPNG, FormatWebP:
	default:
		return fe("Choose JPEG, PNG or WebP", "format")
	}
	if o.Quality < 1 || o.Quality > 100 {
		return fe("Quality must be between 1 and 100", "quality")
	}
	if len(o.Name) > MaxName {
		return fe("The name pattern is too long", "name")
	}
	return o.Watermark.validate()
}

func (w Watermark) validate() error {
	fe := func(msg, field string) error {
		return core.ValidationError(msg, map[string]string{"watermark." + field: msg})
	}
	switch w.Kind {
	case WatermarkNone:
		return nil
	case WatermarkText:
		if strings.TrimSpace(w.Text) == "" {
			return fe("Type the watermark text", "text")
		}
		if len([]rune(w.Text)) > MaxWMText {
			return fe("The watermark text is too long", "text")
		}
		if _, _, _, ok := parseColor(w.Color); !ok {
			return fe("Use a colour like #ffffff", "color")
		}
		if !fontOK(w) {
			return fe("Choose a font from the list", "font")
		}
	case WatermarkLogo:
		if strings.TrimSpace(w.Logo) == "" {
			return fe("Choose the logo image", "logo")
		}
	default:
		return fe("Choose text, a logo or none", "kind")
	}
	switch w.Corner {
	case CornerTopLeft, CornerTopRight, CornerBottomLeft, CornerBottomRight, CornerCenter:
	default:
		return fe("Choose a corner", "corner")
	}
	if math.IsNaN(w.Opacity) || w.Opacity < 0.05 || w.Opacity > 1 {
		return fe("Opacity must be between 5% and 100%", "opacity")
	}
	if math.IsNaN(w.Size) || w.Size < 2 || w.Size > 60 {
		return fe("Size must be between 2% and 60%", "size")
	}
	return nil
}
