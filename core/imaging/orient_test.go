package imaging

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
)

// exifTIFF builds a minimal TIFF block whose IFD0 holds one orientation tag
// (after a decoy entry).
func exifTIFF(bo binary.ByteOrder, o uint16) []byte {
	var b bytes.Buffer
	if bo == binary.LittleEndian {
		b.WriteString("II")
	} else {
		b.WriteString("MM")
	}
	_ = binary.Write(&b, bo, uint16(42))
	_ = binary.Write(&b, bo, uint32(8))
	_ = binary.Write(&b, bo, uint16(2))
	_ = binary.Write(&b, bo, uint16(0x010F))
	_ = binary.Write(&b, bo, uint16(2))
	_ = binary.Write(&b, bo, uint32(1))
	_ = binary.Write(&b, bo, uint32(0))
	_ = binary.Write(&b, bo, uint16(0x0112))
	_ = binary.Write(&b, bo, uint16(3))
	_ = binary.Write(&b, bo, uint32(1))
	_ = binary.Write(&b, bo, o)
	_ = binary.Write(&b, bo, uint16(0))
	_ = binary.Write(&b, bo, uint32(0))
	return b.Bytes()
}

// jpegWithExif encodes a small JPEG and inserts a decoy segment and an APP1
// Exif segment right after SOI.
func jpegWithExif(t *testing.T, tiff []byte) []byte {
	t.Helper()
	var enc bytes.Buffer
	if err := jpeg.Encode(&enc, image.NewNRGBA(image.Rect(0, 0, 8, 8)), nil); err != nil {
		t.Fatal(err)
	}
	raw := enc.Bytes()
	var out bytes.Buffer
	out.Write(raw[:2])
	out.Write([]byte{0xFF, 0xE0, 0x00, 0x04, 'x', 'y'})
	payload := append([]byte("Exif\x00\x00"), tiff...)
	out.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&out, binary.BigEndian, uint16(len(payload)+2))
	out.Write(payload)
	out.Write(raw[2:])
	return out.Bytes()
}

func TestOrientationJPEG(t *testing.T) {
	dir := t.TempDir()
	for _, bo := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
		for o := 1; o <= 8; o++ {
			p := filepath.Join(dir, "a.jpg")
			if err := os.WriteFile(p, jpegWithExif(t, exifTIFF(bo, uint16(o))), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := Orientation(p); got != o {
				t.Errorf("%v orientation %d: got %d", bo, o, got)
			}
			f, _ := os.Open(p)
			if _, err := jpeg.Decode(f); err != nil {
				t.Errorf("decode: %v", err)
			}
			f.Close()
		}
	}
}

func TestOrientationOther(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	plain := new(bytes.Buffer)
	_ = jpeg.Encode(plain, image.NewNRGBA(image.Rect(0, 0, 4, 4)), nil)
	tiffBlock := exifTIFF(binary.LittleEndian, 6)
	cases := []struct {
		name string
		path string
		want int
	}{
		{"tiff little", write("a.tif", tiffBlock), 6},
		{"tiff big", write("b.tif", exifTIFF(binary.BigEndian, 3)), 3},
		{"jpeg without exif", write("c.jpg", plain.Bytes()), 1},
		{"empty", write("d.jpg", nil), 1},
		{"garbage", write("e.jpg", []byte("not an image at all")), 1},
		{"truncated tiff", write("f.tif", tiffBlock[:14]), 1},
		{"bad value", write("g.tif", exifTIFF(binary.LittleEndian, 9)), 1},
		{"truncated jpeg", write("h.jpg", []byte{0xFF, 0xD8, 0xFF, 0xE1, 0x00}), 1},
		{"missing", filepath.Join(dir, "none.jpg"), 1},
	}
	for _, c := range cases {
		if got := Orientation(c.path); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}
}

func TestOrient(t *testing.T) {
	// A B C / D E F, each a distinct red value.
	src := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	names := "ABCDEF"
	for i := 0; i < 6; i++ {
		src.SetNRGBA(i%3, i/3, color.NRGBA{R: names[i], A: 255})
	}
	want := map[int][]string{
		1: {"ABC", "DEF"},
		2: {"CBA", "FED"},
		3: {"FED", "CBA"},
		4: {"DEF", "ABC"},
		5: {"AD", "BE", "CF"},
		6: {"DA", "EB", "FC"},
		7: {"FC", "EB", "DA"},
		8: {"CF", "BE", "AD"},
	}
	for o, rows := range want {
		got := Orient(src, o)
		b := got.Bounds()
		if b.Dx() != len(rows[0]) || b.Dy() != len(rows) {
			t.Errorf("o=%d: size %dx%d", o, b.Dx(), b.Dy())
			continue
		}
		for y, row := range rows {
			for x := range row {
				r, _, _, _ := got.At(x, y).RGBA()
				if byte(r>>8) != row[x] {
					t.Errorf("o=%d (%d,%d): got %c want %c", o, x, y, byte(r>>8), row[x])
				}
			}
		}
	}
	if Orient(src, 0) != image.Image(src) || Orient(src, 9) != image.Image(src) {
		t.Error("out-of-range orientation should return the input")
	}
}
