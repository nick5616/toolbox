//go:build ignore

// Command icongen draws the Toolbox icon from one set of shapes and writes
// every raster/vector variant (Phase 4 SPEC.md §3.6). Run from the repo root:
//
//	go run ./build/icongen/main.go
//	wails3 task common:generate:icons   # → build/windows/icon.ico, build/darwin/icons.icns
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"strings"

	"golang.org/x/image/vector"
)

// rrect is a rounded rectangle on the 1024 canvas; hole cuts it out.
type rrect struct {
	x0, y0, x1, y1, r float32
	hole              bool
}

var (
	accent   = color.NRGBA{0xff, 0x8c, 0x42, 0xff}
	tileTop  = color.NRGBA{0x2a, 0x2d, 0x33, 0xff}
	tileBot  = color.NRGBA{0x11, 0x13, 0x16, 0xff}
	tileRim  = color.NRGBA{0x44, 0x48, 0x50, 0xff}
	tile     = rrect{x0: 100, y0: 100, x1: 924, y1: 924, r: 184}
	tileFill = rrect{x0: 100, y0: 104, x1: 924, y1: 924, r: 184} // leaves a 4 px top rim
)

// glyph is the toolbox: handle ring, box (lid + body split by a gap), latch.
var glyph = []rrect{
	{x0: 392, y0: 262, x1: 632, y1: 420, r: 52},             // handle outer
	{x0: 436, y0: 306, x1: 588, y1: 420, r: 16, hole: true}, // handle inner
	{x0: 232, y0: 380, x1: 792, y1: 752, r: 60},             // box
	{x0: 232, y0: 474, x1: 792, y1: 496, hole: true},        // lid/body gap
	{x0: 462, y0: 444, x1: 562, y1: 528, r: 18},             // latch
}

// glyph bounds (for the tray icons).
const gx0, gy0, gx1, gy1 = 232, 262, 792, 752

func main() {
	app := image.NewNRGBA(image.Rect(0, 0, 1024, 1024))
	fill(app, []rrect{tile}, 1, 0, 0, image.NewUniform(tileRim))
	fill(app, []rrect{tileFill}, 1, 0, 0, gradient(1024, tileTop, tileBot))
	fill(app, glyph, 1, 0, 0, image.NewUniform(accent))
	writePNG("build/appicon.png", app)

	// Tray: the glyph alone, fitted into 32 px with 1 px padding.
	const n = 32
	s := float32(n-2) / float32(max(gx1-gx0, gy1-gy0))
	ox := (float32(n) - float32(gx1-gx0)*s) / 2
	oy := (float32(n) - float32(gy1-gy0)*s) / 2
	tray := image.NewNRGBA(image.Rect(0, 0, n, n))
	fill(tray, translate(glyph, -gx0, -gy0), s, ox, oy, image.NewUniform(accent))
	writePNG("desktop/icons/tray.png", tray)
	tmpl := image.NewNRGBA(image.Rect(0, 0, n, n))
	fill(tmpl, translate(glyph, -gx0, -gy0), s, ox, oy, image.NewUniform(color.NRGBA{0, 0, 0, 0xff}))
	writePNG("desktop/icons/tray_template.png", tmpl)

	// Vector: the full icon for the macOS icon composer, the glyph for the sidebar.
	writeFile("build/appicon.icon/Assets/toolbox.svg", svgIcon())
	writeFile("build/appicon.icon/Assets/toolbox_glyph.svg", svgGlyphLayer())
	writeFile("frontend/src/assets/logo.svg", svgGlyph())
}

func translate(rs []rrect, dx, dy float32) []rrect {
	out := make([]rrect, len(rs))
	for i, r := range rs {
		r.x0, r.x1, r.y0, r.y1 = r.x0+dx, r.x1+dx, r.y0+dy, r.y1+dy
		out[i] = r
	}
	return out
}

// fill rasterises rs (holes wound the other way) scaled by s and offset by
// (ox, oy), painting src through the coverage mask.
func fill(dst *image.NRGBA, rs []rrect, s, ox, oy float32, src image.Image) {
	b := dst.Bounds()
	z := vector.NewRasterizer(b.Dx(), b.Dy())
	for _, r := range rs {
		addRRect(z, r, s, ox, oy)
	}
	z.Draw(dst, b, src, image.Point{})
}

// k approximates a quarter circle with a cubic Bézier.
const k = 0.5523

func addRRect(z *vector.Rasterizer, r rrect, s, ox, oy float32) {
	x0, y0, x1, y1, rad := r.x0*s+ox, r.y0*s+oy, r.x1*s+ox, r.y1*s+oy, r.r*s
	c := rad * (1 - k)
	if !r.hole { // clockwise
		z.MoveTo(x0+rad, y0)
		z.LineTo(x1-rad, y0)
		z.CubeTo(x1-c, y0, x1, y0+c, x1, y0+rad)
		z.LineTo(x1, y1-rad)
		z.CubeTo(x1, y1-c, x1-c, y1, x1-rad, y1)
		z.LineTo(x0+rad, y1)
		z.CubeTo(x0+c, y1, x0, y1-c, x0, y1-rad)
		z.LineTo(x0, y0+rad)
		z.CubeTo(x0, y0+c, x0+c, y0, x0+rad, y0)
	} else { // counter-clockwise: cancels coverage
		z.MoveTo(x0+rad, y0)
		z.CubeTo(x0+c, y0, x0, y0+c, x0, y0+rad)
		z.LineTo(x0, y1-rad)
		z.CubeTo(x0, y1-c, x0+c, y1, x0+rad, y1)
		z.LineTo(x1-rad, y1)
		z.CubeTo(x1-c, y1, x1, y1-c, x1, y1-rad)
		z.LineTo(x1, y0+rad)
		z.CubeTo(x1, y0+c, x1-c, y0, x1-rad, y0)
	}
	z.ClosePath()
}

func gradient(h int, top, bot color.NRGBA) image.Image {
	im := image.NewNRGBA(image.Rect(0, 0, 1, h))
	for y := range h {
		t := float64(y) / float64(h-1)
		lerp := func(a, b uint8) uint8 { return uint8(float64(a) + (float64(b)-float64(a))*t + 0.5) }
		im.SetNRGBA(0, y, color.NRGBA{lerp(top.R, bot.R), lerp(top.G, bot.G), lerp(top.B, bot.B), 0xff})
	}
	wide := image.NewNRGBA(image.Rect(0, 0, h, h))
	for x := range h {
		draw.Draw(wide, image.Rect(x, 0, x+1, h), im, image.Point{}, draw.Src)
	}
	return wide
}

// svgPath renders rrects as one nonzero path: solids clockwise, holes
// counter-clockwise (so overlapping solids stay filled).
func svgPath(rs []rrect) string {
	var b strings.Builder
	for _, r := range rs {
		w, h, q := r.x1-r.x0-2*r.r, r.y1-r.y0-2*r.r, r.r
		if !r.hole {
			fmt.Fprintf(&b, "M%g %gh%gq%g 0 %g %gv%gq0 %g %g %gh%gq%g 0 %g %gv%gq0 %g %g %gz",
				r.x0+q, r.y0, w, q, q, q, h, q, -q, q, -w, -q, -q, -q, -h, -q, q, -q)
		} else {
			fmt.Fprintf(&b, "M%g %gq%g 0 %g %gv%gq0 %g %g %gh%gq%g 0 %g %gv%gq0 %g %g %gz",
				r.x0+q, r.y0, -q, -q, q, h, q, q, q, w, q, q, -q, -h, -q, -q, -q)
		}
	}
	return b.String()
}

func svgIcon() string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2d33"/><stop offset="1" stop-color="#111316"/></linearGradient></defs>
  <path fill="url(#g)" d="` + svgPath([]rrect{tile}) + `"/>
  <path fill="#ff8c42" d="` + svgPath(glyph) + `"/>
</svg>
`
}

// svgGlyphLayer is the orange glyph on the 1024 canvas (Icon Composer layer
// over the graphite fill in build/appicon.icon/icon.json).
func svgGlyphLayer() string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path fill="#ff8c42" d="` + svgPath(glyph) + `"/></svg>
`
}

// svgGlyph is the glyph alone, coloured by CSS (currentColor).
func svgGlyph() string {
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="%d %d %d %d"><path fill="currentColor" d="%s"/></svg>
`, gx0, gy0, gx1-gx0, gy1-gy0, svgPath(glyph))
}

func writePNG(p string, im image.Image) {
	f, err := os.Create(p)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := png.Encode(f, im); err != nil {
		panic(err)
	}
}

func writeFile(p, s string) {
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		panic(err)
	}
}
