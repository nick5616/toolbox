package paint

import (
	"context"
	"fmt"
	"image"
	"image/draw"
	"math"
	"strconv"
)

// blendCh is the separable blend function B(cb, cs) of a Go blend mode on
// channel values in 0..1 (W3C Compositing and Blending Level 1). Modes the Go
// compositor doesn't know blend as normal; exports with such layers carry a
// frontend render instead (ExportOptions.Flattened).
func blendCh(mode string, cb, cs float64) float64 {
	switch mode {
	case "multiply":
		return cb * cs
	case "screen":
		return cb + cs - cb*cs
	case "overlay":
		return hardLight(cs, cb)
	case "add":
		return math.Min(1, cb+cs)
	case "darken":
		return math.Min(cb, cs)
	case "lighten":
		return math.Max(cb, cs)
	}
	return cs
}

func hardLight(cb, cs float64) float64 {
	if cs <= 0.5 {
		return cb * 2 * cs
	}
	s := 2*cs - 1
	return cb + s - cb*s
}

// usesNonGoBlend reports whether a visible layer needs the frontend's render.
func usesNonGoBlend(doc PaintDoc) bool {
	for _, l := range doc.Layers {
		if l.Hidden {
			continue
		}
		if !inStrings(GoBlends, l.Blend) {
			return true
		}
	}
	return false
}

func inStrings(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func parseHex(c string) (r, g, b uint8) {
	if len(c) != 7 {
		return 0, 0, 0
	}
	v, _ := strconv.ParseUint(c[1:], 16, 32)
	return uint8(v >> 16), uint8(v >> 8), uint8(v)
}

// flattenOpts select what flatten draws.
type flattenOpts struct {
	Background bool   // start from the document's background colour
	Only       string // if set, draw only this layer (ignoring hidden/opacity/blend/clip)
}

// flatten composites the document's visible layers tile by tile, so memory
// stays at the output plus one tile per layer.
func (m *Module) flatten(ctx context.Context, id string, doc PaintDoc, o flattenOpts) (*image.NRGBA, error) {
	out := image.NewNRGBA(image.Rect(0, 0, doc.Width, doc.Height))
	var bgR, bgG, bgB uint8
	bgA := uint8(0)
	if o.Background && doc.Background != "transparent" {
		bgR, bgG, bgB = parseHex(doc.Background)
		bgA = 255
	}
	dirs := make([]string, len(doc.Layers))
	for i, l := range doc.Layers {
		d, err := m.layerDir(id, l.ID)
		if err != nil {
			return nil, err
		}
		dirs[i] = d
	}
	nx, ny := gridSize(doc.Width, doc.Height)
	for ty := 0; ty < ny; ty++ {
		for tx := 0; tx < nx; tx++ {
			if err := ctx.Err(); err != nil {
				return nil, fmt.Errorf("flatten cancelled: %w", err)
			}
			r := tileRect(tx, ty, doc.Width, doc.Height)
			n := r.Dx() * r.Dy()
			acc := make([]float64, n*4) // straight RGBA, 0..1
			for i := 0; i < n; i++ {
				acc[i*4], acc[i*4+1], acc[i*4+2], acc[i*4+3] = float64(bgR)/255, float64(bgG)/255, float64(bgB)/255, float64(bgA)/255
			}
			key := tileKey(tx, ty)
			var base *image.NRGBA // the tile of the layer a clip layer clips to
			for i, l := range doc.Layers {
				if o.Only != "" {
					if l.ID != o.Only {
						continue
					}
				} else if l.Hidden {
					if !l.Clip {
						base = nil
					}
					continue
				}
				tile, err := loadTile(dirs[i], key)
				if err != nil {
					return nil, err
				}
				clipTo := (*image.NRGBA)(nil)
				if o.Only == "" && l.Clip {
					if base == nil {
						continue
					}
					clipTo = base
				} else {
					base = tile
				}
				if tile == nil {
					continue
				}
				opacity, mode := l.Opacity, l.Blend
				if o.Only != "" {
					opacity, mode = 1, "normal"
				}
				compositeTile(acc, tile, clipTo, r, opacity, mode)
			}
			for i := 0; i < n; i++ {
				x, y := r.Min.X+i%r.Dx(), r.Min.Y+i/r.Dx()
				p := out.PixOffset(x, y)
				for c := 0; c < 4; c++ {
					out.Pix[p+c] = uint8(math.Round(acc[i*4+c] * 255))
				}
			}
		}
	}
	return out, nil
}

// compositeTile blends one layer tile onto acc (W3C source-over with a
// separable blend function).
func compositeTile(acc []float64, tile, clipTo *image.NRGBA, r image.Rectangle, opacity float64, mode string) {
	w := r.Dx()
	tw, th := tile.Bounds().Dx(), tile.Bounds().Dy()
	for y := 0; y < min(th, r.Dy()); y++ {
		for x := 0; x < min(tw, w); x++ {
			p := tile.PixOffset(x, y)
			sa := float64(tile.Pix[p+3]) / 255 * opacity
			if clipTo != nil {
				if x >= clipTo.Bounds().Dx() || y >= clipTo.Bounds().Dy() {
					continue
				}
				sa *= float64(clipTo.Pix[clipTo.PixOffset(x, y)+3]) / 255
			}
			if sa <= 0 {
				continue
			}
			a := acc[(y*w+x)*4 : (y*w+x)*4+4]
			ab := a[3]
			ar := sa + ab*(1-sa)
			for c := 0; c < 3; c++ {
				cs := float64(tile.Pix[p+c]) / 255
				cb := a[c]
				a[c] = ((1-sa)*ab*cb + sa*((1-ab)*cs+ab*blendCh(mode, cb, cs))) / ar
			}
			a[3] = ar
		}
	}
}

// layerImage is one layer's pixels over the whole canvas.
func (m *Module) layerImage(ctx context.Context, id string, l PaintLayer, w, h int) (*image.NRGBA, error) {
	dir, err := m.layerDir(id, l.ID)
	if err != nil {
		return nil, err
	}
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	for _, k := range l.Tiles {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("read layer cancelled: %w", err)
		}
		tx, ty, ok := parseKey(k)
		if !ok {
			continue
		}
		t, err := loadTile(dir, k)
		if err != nil {
			return nil, err
		}
		if t == nil {
			continue
		}
		r := tileRect(tx, ty, w, h)
		if r.Empty() {
			continue
		}
		draw.Draw(out, r, t, image.Point{}, draw.Src)
	}
	return out, nil
}

// fitOnto draws src centred on dst according to fit.
func fitOnto(dst *image.NRGBA, src *image.NRGBA, fit string) {
	dw, dh := float64(dst.Bounds().Dx()), float64(dst.Bounds().Dy())
	sw, sh := float64(src.Bounds().Dx()), float64(src.Bounds().Dy())
	var tw, th float64
	switch fit {
	case "stretch":
		tw, th = dw, dh
	case "cover":
		f := math.Max(dw/sw, dh/sh)
		tw, th = sw*f, sh*f
	default:
		f := math.Min(dw/sw, dh/sh)
		tw, th = sw*f, sh*f
	}
	w, h := max(1, int(math.Round(tw))), max(1, int(math.Round(th)))
	scaled := resize(src, w, h)
	x0, y0 := (dst.Bounds().Dx()-w)/2, (dst.Bounds().Dy()-h)/2
	draw.Draw(dst, image.Rect(x0, y0, x0+w, y0+h).Intersect(dst.Bounds()), scaled,
		image.Pt(max(0, -x0), max(0, -y0)), draw.Over)
}
