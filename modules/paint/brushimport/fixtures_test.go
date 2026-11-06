package brushimport

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"testing"

	"howett.net/plist"
)

// Synthetic fixtures: every file the tests import is built here, never copied from a real brush pack.

func zipBytes(t testing.TB, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// grayPNG makes a w x h opaque grayscale PNG from f(x, y).
func grayPNG(t testing.TB, w, h int, f func(x, y int) uint8) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetGray(x, y, color.Gray{Y: f(x, y)})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// alphaPNG makes a black PNG whose alpha is f(x, y).
func alphaPNG(t testing.TB, w, h int, f func(x, y int) uint8) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{A: f(x, y)})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// archiveBuilder builds an NSKeyedArchiver binary plist like Procreate's Brush.archive.
type archiveBuilder struct{ objects []any }

func newArchive() *archiveBuilder { return &archiveBuilder{objects: []any{"$null"}} }

func (a *archiveBuilder) add(v any) plist.UID {
	a.objects = append(a.objects, v)
	return plist.UID(len(a.objects) - 1)
}

// brush returns the archive of a SilicaBrush whose fields are the given values:
// strings become referenced objects, everything else is stored inline.
func (a *archiveBuilder) brush(fields map[string]any) []byte {
	class := a.add(map[string]any{"$classname": "SilicaBrush", "$classes": []any{"SilicaBrush", "NSObject"}})
	root := map[string]any{"$class": class}
	for k, v := range fields {
		if s, ok := v.(string); ok {
			root[k] = a.add(s)
		} else {
			root[k] = v
		}
	}
	rootUID := a.add(root)
	top := map[string]any{
		"$archiver": "NSKeyedArchiver",
		"$version":  uint64(100000),
		"$top":      map[string]any{"root": rootUID},
		"$objects":  a.objects,
	}
	data, err := plist.Marshal(top, plist.BinaryFormat)
	if err != nil {
		panic(err)
	}
	return data
}

func procreateBrush(name string, fields map[string]any) []byte {
	f := map[string]any{"name": name}
	for k, v := range fields {
		f[k] = v
	}
	return newArchive().brush(f)
}

func brushsetPlist(t testing.TB, name string, order []string) []byte {
	t.Helper()
	arr := make([]any, len(order))
	for i, o := range order {
		arr[i] = o
	}
	data, err := plist.Marshal(map[string]any{"name": name, "brushes": arr}, plist.XMLFormat)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// abrFile builds a Photoshop v6 file: header, a samp section with the given
// records, then extra sections.
func abrFile(records [][]byte, extra ...[2]string) []byte {
	var samp bytes.Buffer
	for _, r := range records {
		binary.Write(&samp, binary.BigEndian, uint32(len(r)))
		samp.Write(r)
		for samp.Len()%4 != 0 {
			samp.WriteByte(0)
		}
	}
	var out bytes.Buffer
	binary.Write(&out, binary.BigEndian, uint16(6))
	binary.Write(&out, binary.BigEndian, uint16(1))
	section := func(key string, data []byte) {
		out.WriteString("8BIM")
		out.WriteString(key)
		binary.Write(&out, binary.BigEndian, uint32(len(data)))
		out.Write(data)
		for out.Len()%4 != 0 {
			out.WriteByte(0)
		}
	}
	section("samp", samp.Bytes())
	for _, e := range extra {
		section(e[0], []byte(e[1]))
	}
	return out.Bytes()
}

// sampRecord builds one sampled tip. rle packs rows with PackBits.
func sampRecord(w, h int, f func(x, y int) uint8, rle bool) []byte {
	var b bytes.Buffer
	key := "00000000-0000-0000-0000-000000000001"
	b.WriteByte(byte(len(key)))
	b.WriteString(key)
	b.Write(make([]byte, 10))
	for _, v := range []int32{0, 0, int32(h), int32(w)} { // top, left, bottom, right
		binary.Write(&b, binary.BigEndian, v)
	}
	binary.Write(&b, binary.BigEndian, uint16(8))
	if !rle {
		b.WriteByte(0)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				b.WriteByte(f(x, y))
			}
		}
		return b.Bytes()
	}
	b.WriteByte(1)
	rows := make([][]byte, h)
	for y := 0; y < h; y++ {
		row := make([]byte, w)
		for x := range row {
			row[x] = f(x, y)
		}
		// literal run of the whole row (PackBits: n-1 then bytes), w <= 128
		rows[y] = append([]byte{byte(w - 1)}, row...)
		binary.Write(&b, binary.BigEndian, uint16(len(rows[y])))
	}
	for _, r := range rows {
		b.Write(r)
	}
	return b.Bytes()
}

// gbrBytes builds a GIMP brush v2.
func gbrBytes(w, h, bpp int, name string, spacing int, f func(i int) []byte) []byte {
	var b bytes.Buffer
	hdr := 28 + len(name) + 1
	for _, v := range []uint32{uint32(hdr), 2, uint32(w), uint32(h), uint32(bpp)} {
		binary.Write(&b, binary.BigEndian, v)
	}
	b.WriteString("GIMP")
	binary.Write(&b, binary.BigEndian, uint32(spacing))
	b.WriteString(name)
	b.WriteByte(0)
	for i := 0; i < w*h; i++ {
		b.Write(f(i))
	}
	return b.Bytes()
}

// patBytes builds a GIMP pattern with 1 byte per pixel.
func patBytes(w, h int, name string, f func(i int) byte) []byte {
	var b bytes.Buffer
	hdr := 24 + len(name) + 1
	for _, v := range []uint32{uint32(hdr), 1, uint32(w), uint32(h), 1} {
		binary.Write(&b, binary.BigEndian, v)
	}
	b.WriteString("GPAT")
	b.WriteString(name)
	b.WriteByte(0)
	for i := 0; i < w*h; i++ {
		b.WriteByte(f(i))
	}
	return b.Bytes()
}

func decodeMask(t testing.TB, data []byte) (w, h int, alpha []uint8) {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	w, h = b.Dx(), b.Dy()
	alpha = make([]uint8, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			alpha[y*w+x] = uint8(a >> 8)
		}
	}
	return
}
