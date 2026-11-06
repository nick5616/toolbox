package brushimport

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

// ParseABR reads the sampled tips of a Photoshop .abr (version 6 and later).
// A v6+ file is a version header followed by "8BIM" sections; the "samp"
// section holds one record per sampled tip:
//
//	uint32 length (records are padded to 4 bytes)
//	pascal string key (a 36-character ID)
//	10 bytes (coordinates and an unknown short)
//	4 x int32 bounds: top, left, bottom, right
//	uint16 depth (8 or 16 bits)
//	byte compression (0 = raw, 1 = PackBits per row, row sizes first)
//	the pixels
//
// Other sections (desc: brush settings, patt: patterns) are skipped and
// named in the fidelity notes. Tips get default dynamics.
func ParseABR(data []byte, fileName string) (*Result, error) {
	if len(data) < 8 {
		return nil, errors.New("not a Photoshop brush file")
	}
	version := binary.BigEndian.Uint16(data[0:2])
	if version < 6 || version > 12 {
		return nil, fmt.Errorf("Photoshop brush file version %d isn't supported (only version 6 and later)", version)
	}
	res := &Result{Set: Set{Name: strings.TrimSuffix(fileName, extOf(fileName)), Source: SourceABR, Files: map[string][]byte{}}}
	var n notes
	var skippedSections []string

	pos := 4
	for pos+12 <= len(data) {
		if string(data[pos:pos+4]) != "8BIM" {
			break
		}
		key := string(data[pos+4 : pos+8])
		size := int(binary.BigEndian.Uint32(data[pos+8 : pos+12]))
		start := pos + 12
		end := start + size
		if size < 0 || end > len(data) {
			end = len(data)
		}
		if key == "samp" {
			if err := parseSamp(data[start:end], res, &n); err != nil {
				return nil, err
			}
		} else {
			skippedSections = append(skippedSections, key)
		}
		// The next section follows, possibly after padding.
		next := -1
		for pad := 0; pad < 4; pad++ {
			if end+pad+4 <= len(data) && bytes.Equal(data[end+pad:end+pad+4], []byte("8BIM")) {
				next = end + pad
				break
			}
		}
		if next < 0 {
			break
		}
		pos = next
	}
	if len(res.Set.Brushes) == 0 {
		return nil, errors.New("no sampled brush tips found (this file may only contain computed brushes)")
	}
	n.add("Only sampled tips were imported, with default dynamics; Photoshop's brush settings aren't read.")
	if len(skippedSections) > 0 {
		n.add("Skipped sections: %s.", strings.Join(skippedSections, ", "))
	}
	n.add("Tip images are assumed to be 255 = paint; turn on Invert on the tip if one looks reversed.")
	res.Fidelity = n.list
	return res, nil
}

func extOf(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return name[i:]
	}
	return ""
}

func parseSamp(sec []byte, res *Result, n *notes) error {
	off := 0
	idx := 0
	for off+4 <= len(sec) {
		rl := int(binary.BigEndian.Uint32(sec[off : off+4]))
		if rl <= 0 || off+4+rl > len(sec) {
			break
		}
		rec := sec[off+4 : off+4+rl]
		off += 4 + (rl+3)&^3
		idx++
		mask, w, h, err := parseSampRecord(rec)
		if err != nil {
			n.add("Tip %d was skipped: %v.", idx, err)
			continue
		}
		mask, w, h, scaled := downscale(mask, w, h, MaxTipSide)
		if scaled {
			n.add("Large tip images were scaled down to %d px.", MaxTipSide)
		}
		png, err := EncodeTip(mask, w, h)
		if err != nil {
			return err
		}
		name := fmt.Sprintf("Tip %d", idx)
		file := res.Set.addFile("tips", name, png)
		p := NewPreset(name)
		p.Size = float64(minInt(maxInt(w, h), 200))
		p.Spacing = 0.25
		p.Tip.Shape = Ref(file)
		p.Dynamics = []Dynamics{{Input: "pressure", Target: "size", Amount: 0.5, Curve: Curve{{0, 0}, {1, 1}}}}
		if err := res.Set.add(p); err != nil {
			return err
		}
	}
	return nil
}

func parseSampRecord(rec []byte) (mask []uint8, w, h int, err error) {
	if len(rec) < 1 {
		return nil, 0, 0, errors.New("empty record")
	}
	pos := 1 + int(rec[0]) // pascal string key
	pos += 10
	if pos+16+2+1 > len(rec) {
		return nil, 0, 0, errors.New("record is too short")
	}
	top := int(int32(binary.BigEndian.Uint32(rec[pos:])))
	left := int(int32(binary.BigEndian.Uint32(rec[pos+4:])))
	bottom := int(int32(binary.BigEndian.Uint32(rec[pos+8:])))
	right := int(int32(binary.BigEndian.Uint32(rec[pos+12:])))
	pos += 16
	depth := int(binary.BigEndian.Uint16(rec[pos:]))
	compress := rec[pos+2]
	pos += 3
	w, h = right-left, bottom-top
	if w <= 0 || h <= 0 || w > MaxImageSide || h > MaxImageSide {
		return nil, 0, 0, fmt.Errorf("size %d x %d is outside the limits", w, h)
	}
	if depth != 8 && depth != 16 {
		return nil, 0, 0, fmt.Errorf("%d-bit tips aren't supported", depth)
	}
	bpp := depth / 8
	rowBytes := w * bpp
	pix := rec[pos:]
	raw := make([]byte, 0, rowBytes*h)
	switch compress {
	case 0:
		if len(pix) < rowBytes*h {
			return nil, 0, 0, errors.New("pixel data is truncated")
		}
		raw = pix[:rowBytes*h]
	case 1:
		if len(pix) < 2*h {
			return nil, 0, 0, errors.New("pixel data is truncated")
		}
		src := pix[2*h:]
		for y := 0; y < h; y++ {
			rowLen := int(binary.BigEndian.Uint16(pix[2*y:]))
			if rowLen > len(src) {
				return nil, 0, 0, errors.New("pixel data is truncated")
			}
			row, err := unpackBits(src[:rowLen], rowBytes)
			if err != nil {
				return nil, 0, 0, err
			}
			raw = append(raw, row...)
			src = src[rowLen:]
		}
	default:
		return nil, 0, 0, fmt.Errorf("compression %d isn't supported", compress)
	}
	mask = make([]uint8, w*h)
	for i := range mask {
		mask[i] = raw[i*bpp] // 16-bit: the high byte
	}
	return mask, w, h, nil
}

// unpackBits decodes one PackBits row into exactly want bytes.
func unpackBits(src []byte, want int) ([]byte, error) {
	out := make([]byte, 0, want)
	for i := 0; i < len(src) && len(out) < want; {
		c := int(int8(src[i]))
		i++
		switch {
		case c >= 0:
			n := c + 1
			if i+n > len(src) {
				return nil, errors.New("pixel data is corrupt")
			}
			out = append(out, src[i:i+n]...)
			i += n
		case c != -128:
			if i >= len(src) {
				return nil, errors.New("pixel data is corrupt")
			}
			for k := 0; k < 1-c; k++ {
				out = append(out, src[i])
			}
			i++
		}
	}
	if len(out) < want {
		return nil, errors.New("pixel data is truncated")
	}
	return out[:want], nil
}
