package imaging

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/draw"
	"io"
	"os"
)

// EXIF orientation (SPEC.md Part B §B0.2): a minimal reader for the JPEG APP1
// "Exif" segment and TIFF headers (tag 0x0112), and the eight transforms.

// maxExifScan bounds how much of a file is read looking for the orientation.
const maxExifScan = 1 << 20

// Orientation returns the EXIF orientation (1–8) of a JPEG or TIFF file; 1
// when there is none or it can't be read.
func Orientation(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 1
	}
	defer f.Close()
	head := make([]byte, 4)
	if _, err := io.ReadFull(f, head); err != nil {
		return 1
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 1
	}
	switch {
	case head[0] == 0xFF && head[1] == 0xD8:
		tiff := jpegExif(f)
		if tiff == nil {
			return 1
		}
		return tiffOrientation(tiff)
	case bytes.HasPrefix(head, []byte("II*\x00")) || bytes.HasPrefix(head, []byte("MM\x00*")):
		b, err := io.ReadAll(io.LimitReader(f, maxExifScan))
		if err != nil {
			return 1
		}
		return tiffOrientation(b)
	}
	return 1
}

// jpegExif returns the TIFF block of the first APP1 "Exif" segment.
func jpegExif(r io.Reader) []byte {
	var soi [2]byte
	if _, err := io.ReadFull(r, soi[:]); err != nil {
		return nil
	}
	scanned := 0
	for scanned < maxExifScan {
		var m [2]byte
		if _, err := io.ReadFull(r, m[:]); err != nil {
			return nil
		}
		for m[0] != 0xFF { // resync on stray bytes
			m[0] = m[1]
			if _, err := io.ReadFull(r, m[1:]); err != nil {
				return nil
			}
		}
		for m[1] == 0xFF { // fill bytes
			if _, err := io.ReadFull(r, m[1:]); err != nil {
				return nil
			}
		}
		marker := m[1]
		if marker == 0xD9 || marker == 0xDA { // EOI or start of scan: no Exif before the image
			return nil
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) { // no length
			continue
		}
		var l [2]byte
		if _, err := io.ReadFull(r, l[:]); err != nil {
			return nil
		}
		n := int(binary.BigEndian.Uint16(l[:])) - 2
		if n < 0 {
			return nil
		}
		scanned += n + 4
		if marker == 0xE1 {
			seg := make([]byte, n)
			if _, err := io.ReadFull(r, seg); err != nil {
				return nil
			}
			if bytes.HasPrefix(seg, []byte("Exif\x00\x00")) {
				return seg[6:]
			}
			continue
		}
		if _, err := io.CopyN(io.Discard, r, int64(n)); err != nil {
			return nil
		}
	}
	return nil
}

// tiffOrientation reads tag 0x0112 from IFD0 of a TIFF block.
func tiffOrientation(b []byte) int {
	if len(b) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(b[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	if bo.Uint16(b[2:4]) != 42 {
		return 1
	}
	off := int(bo.Uint32(b[4:8]))
	if off < 8 || off+2 > len(b) {
		return 1
	}
	count := int(bo.Uint16(b[off : off+2]))
	for i := 0; i < count; i++ {
		e := off + 2 + i*12
		if e+12 > len(b) {
			return 1
		}
		if bo.Uint16(b[e:e+2]) != 0x0112 {
			continue
		}
		if bo.Uint16(b[e+2:e+4]) != 3 || bo.Uint32(b[e+4:e+8]) < 1 { // SHORT
			return 1
		}
		v := int(bo.Uint16(b[e+8 : e+10]))
		if v < 1 || v > 8 {
			return 1
		}
		return v
	}
	return 1
}

// Orient returns img transformed for EXIF orientation o (1 = unchanged).
func Orient(img image.Image, o int) image.Image {
	if o < 2 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	src, ok := img.(*image.NRGBA)
	if !ok || src.Rect.Min != (image.Point{}) {
		n := image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.Draw(n, n.Bounds(), img, b.Min, draw.Src)
		src = n
	}
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sx, sy int
			switch o {
			case 2:
				sx, sy = w-1-x, y
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sx, sy = x, h-1-y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			}
			si := sy*src.Stride + sx*4
			di := y*dst.Stride + x*4
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}
