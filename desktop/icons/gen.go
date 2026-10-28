//go:build ignore

// Command gen downsamples build/appicon.png into the 32 px tray icons.
// Run from the repo root: go run ./desktop/icons/gen.go
package main

import (
	"image"
	"image/color"
	"image/png"
	"os"
)

func main() {
	f, err := os.Open("build/appicon.png")
	if err != nil {
		panic(err)
	}
	defer f.Close()
	src, err := png.Decode(f)
	if err != nil {
		panic(err)
	}
	const n = 32
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	full := image.NewNRGBA(image.Rect(0, 0, n, n))
	tmpl := image.NewNRGBA(image.Rect(0, 0, n, n))
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			x0, x1 := x*sw/n, (x+1)*sw/n
			y0, y1 := y*sh/n, (y+1)*sh/n
			var sum, cnt float64
			for yy := y0; yy < y1; yy++ {
				for xx := x0; xx < x1; xx++ {
					r, g, bl, _ := src.At(b.Min.X+xx, b.Min.Y+yy).RGBA()
					sum += (0.299*float64(r) + 0.587*float64(g) + 0.114*float64(bl)) / 65535
					cnt++
				}
			}
			lum := sum / cnt
			v := uint8(lum*255 + 0.5)
			full.SetNRGBA(x, y, color.NRGBA{v, v, v, 255})
			tmpl.SetNRGBA(x, y, color.NRGBA{0, 0, 0, uint8((1-lum)*255 + 0.5)})
		}
	}
	write("desktop/icons/tray.png", full)
	write("desktop/icons/tray_template.png", tmpl)
}

func write(p string, im image.Image) {
	o, err := os.Create(p)
	if err != nil {
		panic(err)
	}
	defer o.Close()
	if err := png.Encode(o, im); err != nil {
		panic(err)
	}
}
