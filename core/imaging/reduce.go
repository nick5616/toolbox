package imaging

import (
	"image"
	"image/color"
)

// reduce shrinks src by a whole factor with a box filter (an exact average of
// each k×k block) when it is at least four times larger than maxDim, so the
// CatmullRom pass that follows works on ≤ 4× the output. CatmullRom's cost
// grows with the source: a 10 MP photo to 256 px takes ~280 ms with it alone
// and ~25 ms after this. JPEGs (YCbCr) and 8-bit RGBA/NRGBA are reduced; any
// other image is returned unchanged.
func reduce(src image.Image, maxDim int) image.Image {
	b := src.Bounds()
	k := max(b.Dx(), b.Dy()) / (2 * maxDim)
	if k < 2 {
		return src
	}
	switch im := src.(type) {
	case *image.YCbCr:
		return boxYCbCr(im, k)
	case *image.NRGBA:
		return boxRGBA(im.Pix, im.Stride, b, k, false)
	case *image.RGBA:
		return boxRGBA(im.Pix, im.Stride, b, k, true)
	}
	return src
}

func boxYCbCr(im *image.YCbCr, k int) *image.NRGBA {
	b := im.Bounds()
	ow, oh := (b.Dx()+k-1)/k, (b.Dy()+k-1)/k
	dst := image.NewNRGBA(image.Rect(0, 0, ow, oh))
	ys := make([]uint32, ow)
	cbs := make([]uint32, ow)
	crs := make([]uint32, ow)
	ns := make([]uint32, ow)
	for oy := range oh {
		clear(ys)
		clear(cbs)
		clear(crs)
		clear(ns)
		y0 := b.Min.Y + oy*k
		y1 := min(y0+k, b.Max.Y)
		for y := y0; y < y1; y++ {
			for ox := range ow {
				x0 := b.Min.X + ox*k
				x1 := min(x0+k, b.Max.X)
				var sy, scb, scr uint32
				for x := x0; x < x1; x++ {
					sy += uint32(im.Y[im.YOffset(x, y)])
					ci := im.COffset(x, y)
					scb += uint32(im.Cb[ci])
					scr += uint32(im.Cr[ci])
				}
				ys[ox] += sy
				cbs[ox] += scb
				crs[ox] += scr
				ns[ox] += uint32(x1 - x0)
			}
		}
		row := dst.Pix[oy*dst.Stride:]
		for ox := range ow {
			n := ns[ox]
			r, g, bl := color.YCbCrToRGB(uint8((ys[ox]+n/2)/n), uint8((cbs[ox]+n/2)/n), uint8((crs[ox]+n/2)/n))
			row[ox*4], row[ox*4+1], row[ox*4+2], row[ox*4+3] = r, g, bl, 255
		}
	}
	return dst
}

// boxRGBA averages 8-bit RGBA (premultiplied) or NRGBA pixels. Colours are
// weighted by alpha, so transparent pixels don't darken the edges.
func boxRGBA(pix []uint8, stride int, b image.Rectangle, k int, premultiplied bool) *image.NRGBA {
	ow, oh := (b.Dx()+k-1)/k, (b.Dy()+k-1)/k
	dst := image.NewNRGBA(image.Rect(0, 0, ow, oh))
	type acc struct{ r, g, b, a, n uint64 }
	sums := make([]acc, ow)
	for oy := range oh {
		clear(sums)
		y0 := oy * k
		y1 := min(y0+k, b.Dy())
		for y := y0; y < y1; y++ {
			line := pix[y*stride:]
			for ox := range ow {
				x0 := ox * k
				x1 := min(x0+k, b.Dx())
				s := &sums[ox]
				for x := x0; x < x1; x++ {
					p := line[x*4 : x*4+4 : x*4+4]
					a := uint64(p[3])
					if premultiplied {
						s.r += uint64(p[0]) * 255
						s.g += uint64(p[1]) * 255
						s.b += uint64(p[2]) * 255
					} else {
						s.r += uint64(p[0]) * a
						s.g += uint64(p[1]) * a
						s.b += uint64(p[2]) * a
					}
					s.a += a
				}
				s.n += uint64(x1 - x0)
			}
		}
		row := dst.Pix[oy*dst.Stride:]
		for ox := range ow {
			s := sums[ox]
			o := row[ox*4 : ox*4+4 : ox*4+4]
			if s.a == 0 {
				o[0], o[1], o[2], o[3] = 0, 0, 0, 0
				continue
			}
			o[0] = uint8(min(255, (s.r+s.a/2)/s.a))
			o[1] = uint8(min(255, (s.g+s.a/2)/s.a))
			o[2] = uint8(min(255, (s.b+s.a/2)/s.a))
			o[3] = uint8((s.a + s.n/2) / s.n)
		}
	}
	return dst
}
