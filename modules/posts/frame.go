package posts

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"math"
	"strings"

	xdraw "golang.org/x/image/draw"
)

// Framing maths (SPEC.md §B7.3): the crop window is the largest window of the
// frame's aspect that fits the source, divided by zoom, centred at pan.

// cropWindow returns the window (in source pixels) for a w×h source framed to
// aspect (frame width / height) at the given zoom and pan (-1..1).
func cropWindow(w, h float64, aspect, zoom, panX, panY float64) (x, y, cw, ch float64) {
	if zoom < 1 {
		zoom = 1
	}
	if w/h > aspect {
		ch, cw = h, h*aspect
	} else {
		cw, ch = w, w/aspect
	}
	cw, ch = cw/zoom, ch/zoom
	panX, panY = min(max(panX, -1), 1), min(max(panY, -1), 1)
	x = (w-cw)/2 + panX*(w-cw)/2
	y = (h-ch)/2 + panY*(h-ch)/2
	return x, y, cw, ch
}

// windowRect rounds a crop window to pixels inside bounds b.
func windowRect(b image.Rectangle, x, y, cw, ch float64) image.Rectangle {
	rw := min(max(int(math.Round(cw)), 1), b.Dx())
	rh := min(max(int(math.Round(ch)), 1), b.Dy())
	rx := min(max(int(math.Round(x)), 0), b.Dx()-rw)
	ry := min(max(int(math.Round(y)), 0), b.Dy()-rh)
	return image.Rect(b.Min.X+rx, b.Min.Y+ry, b.Min.X+rx+rw, b.Min.Y+ry+rh)
}

// rotateImage turns img clockwise by deg (0, 90, 180 or 270).
func rotateImage(img image.Image, deg int) image.Image {
	deg = ((deg % 360) + 360) % 360
	if deg == 0 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	var dst *image.NRGBA
	if deg == 180 {
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
	} else {
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.NRGBAModel.Convert(img.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA)
			switch deg {
			case 90:
				dst.SetNRGBA(h-1-y, x, c)
			case 180:
				dst.SetNRGBA(w-1-x, h-1-y, c)
			default: // 270
				dst.SetNRGBA(y, w-1-x, c)
			}
		}
	}
	return dst
}

// frameStill rotates img, crops it to the frame's aspect with pan/zoom and
// resizes to fw×fh. With flatten the result is composited on white (JPEG).
func frameStill(img image.Image, rotation int, panX, panY, zoom float64, fw, fh int, flatten bool) *image.RGBA {
	img = rotateImage(img, rotation)
	b := img.Bounds()
	x, y, cw, ch := cropWindow(float64(b.Dx()), float64(b.Dy()), float64(fw)/float64(fh), zoom, panX, panY)
	src := windowRect(b, x, y, cw, ch)
	dst := image.NewRGBA(image.Rect(0, 0, fw, fh))
	op := xdraw.Src
	if flatten {
		draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
		op = xdraw.Over
	}
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, src, op, nil)
	return dst
}

// clipFilter is the FFmpeg video filter chain that rotates, covers the frame
// with zoom, crops with pan, and normalises to 30 fps yuv420p.
func clipFilter(rotation int, panX, panY, zoom float64, fw, fh int) string {
	if zoom < 1 {
		zoom = 1
	}
	var f []string
	switch ((rotation % 360) + 360) % 360 {
	case 90:
		f = append(f, "transpose=1")
	case 180:
		f = append(f, "hflip", "vflip")
	case 270:
		f = append(f, "transpose=2")
	}
	zw, zh := int(math.Round(float64(fw)*zoom)), int(math.Round(float64(fh)*zoom))
	f = append(f,
		fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase:flags=lanczos", zw, zh),
		fmt.Sprintf("crop=%d:%d:x='(iw-ow)*(1+%.4f)/2':y='(ih-oh)*(1+%.4f)/2'", fw, fh,
			min(max(panX, -1), 1), min(max(panY, -1), 1)),
		"fps=30", "format=yuv420p", "setsar=1")
	return strings.Join(f, ",")
}

// clipArgs builds the FFmpeg arguments for one clip slide.
func clipArgs(src, out string, inMs, outMs int64, rotation int, panX, panY, zoom float64, mute, keepMeta bool, fw, fh int) []string {
	a := []string{"-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
		"-ss", fmt.Sprintf("%.3f", float64(inMs)/1000), "-t", fmt.Sprintf("%.3f", float64(outMs-inMs)/1000),
		"-i", src, "-map", "0:v:0"}
	if !mute {
		a = append(a, "-map", "0:a:0?")
	}
	a = append(a, "-vf", clipFilter(rotation, panX, panY, zoom, fw, fh),
		"-c:v", "libx264", "-profile:v", "high", "-crf", "19", "-preset", "medium")
	if mute {
		a = append(a, "-an")
	} else {
		a = append(a, "-c:a", "aac", "-b:a", "192k", "-ar", "48000")
	}
	if !keepMeta {
		a = append(a, "-map_metadata", "-1", "-map_chapters", "-1")
	}
	return append(a, "-movflags", "+faststart", out)
}
