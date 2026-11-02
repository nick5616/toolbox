package posts

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// A minimal EXIF reader/splicer (SPEC.md §B7.2 GPS note, §B7.3 KeepLocation).
// It understands the JPEG APP1 "Exif" segment and a TIFF IFD0, nothing more.

const (
	tagOrientation = 0x0112
	tagGPSPointer  = 0x8825
	maxExifScan    = 1 << 20 // bytes of a JPEG searched for the Exif segment
)

var exifHeader = []byte("Exif\x00\x00")

// findExifSegment returns the APP1 Exif payload (starting with "Exif\0\0") of
// a JPEG held in data.
func findExifSegment(data []byte) ([]byte, bool) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil, false
	}
	i := 2
	for i+4 <= len(data) {
		if data[i] != 0xFF {
			return nil, false
		}
		marker := data[i+1]
		if marker == 0xFF { // fill byte
			i++
			continue
		}
		if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 {
			i += 2
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // start of scan / end: no more headers
			return nil, false
		}
		n := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if n < 2 || i+2+n > len(data) {
			return nil, false
		}
		if marker == 0xE1 && n-2 >= len(exifHeader) && bytes.Equal(data[i+4:i+4+len(exifHeader)], exifHeader) {
			return data[i+4 : i+2+n], true
		}
		i += 2 + n
	}
	return nil, false
}

// readExifSegment reads the Exif payload of a JPEG file.
func readExifSegment(path string) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, maxExifScan))
	if err != nil {
		return nil, false
	}
	return findExifSegment(buf)
}

func isJPEG(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".jpg" || ext == ".jpeg"
}

func isTIFF(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".tif" || ext == ".tiff"
}

// tiffIFD0 walks IFD0 of the TIFF stream in r (size bytes) and calls fn for
// every entry with its tag and the offset of the entry; fn returns false to
// stop.
func tiffIFD0(r io.ReaderAt, size int64, fn func(tag uint16, entryOff int64, order binary.ByteOrder) bool) {
	var hdr [8]byte
	if size < 8 {
		return
	}
	if _, err := r.ReadAt(hdr[:], 0); err != nil {
		return
	}
	var order binary.ByteOrder
	switch string(hdr[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return
	}
	if order.Uint16(hdr[2:4]) != 42 {
		return
	}
	ifd := int64(order.Uint32(hdr[4:8]))
	if ifd < 8 || ifd+2 > size {
		return
	}
	var cnt [2]byte
	if _, err := r.ReadAt(cnt[:], ifd); err != nil {
		return
	}
	n := int64(order.Uint16(cnt[:]))
	for i := int64(0); i < n; i++ {
		off := ifd + 2 + i*12
		if off+12 > size {
			return
		}
		var e [2]byte
		if _, err := r.ReadAt(e[:], off); err != nil {
			return
		}
		if !fn(order.Uint16(e[:]), off, order) {
			return
		}
	}
}

// tiffHasGPS reports whether IFD0 holds the GPS IFD pointer.
func tiffHasGPS(r io.ReaderAt, size int64) bool {
	found := false
	tiffIFD0(r, size, func(tag uint16, _ int64, _ binary.ByteOrder) bool {
		if tag == tagGPSPointer {
			found = true
			return false
		}
		return true
	})
	return found
}

// hasGPS reports whether a JPEG or TIFF photo carries a GPS IFD.
func hasGPS(path string) bool {
	switch {
	case isJPEG(path):
		seg, ok := readExifSegment(path)
		if !ok {
			return false
		}
		t := seg[len(exifHeader):]
		return tiffHasGPS(bytes.NewReader(t), int64(len(t)))
	case isTIFF(path):
		f, err := os.Open(path)
		if err != nil {
			return false
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil {
			return false
		}
		return tiffHasGPS(f, fi.Size())
	}
	return false
}

// resetOrientation returns a copy of an Exif payload with orientation set to 1.
func resetOrientation(seg []byte) []byte {
	out := append([]byte(nil), seg...)
	t := out[len(exifHeader):]
	tiffIFD0(bytes.NewReader(t), int64(len(t)), func(tag uint16, off int64, order binary.ByteOrder) bool {
		if tag == tagOrientation {
			order.PutUint16(t[off+8:off+10], 1) // SHORT value stored inline
			return false
		}
		return true
	})
	return out
}

// spliceExif inserts an APP1 Exif segment right after the SOI of a JPEG. It
// returns the JPEG unchanged when the payload doesn't fit in one segment.
func spliceExif(jpegData, payload []byte) []byte {
	if len(jpegData) < 2 || len(payload)+2 > 0xFFFF {
		return jpegData
	}
	out := make([]byte, 0, len(jpegData)+len(payload)+4)
	out = append(out, jpegData[:2]...)
	out = append(out, 0xFF, 0xE1)
	out = binary.BigEndian.AppendUint16(out, uint16(len(payload)+2))
	out = append(out, payload...)
	return append(out, jpegData[2:]...)
}
