package imagebatch

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
)

// Keeping metadata (Strip off) is only done JPEG to JPEG: the source's EXIF
// block is copied into the new file with its orientation reset to 1, because
// the pixels are already upright. Everything else is dropped.

const maxExifScan = 1 << 20

// ReadExif returns the payload of the first APP1 "Exif" segment of a JPEG
// file (starting at "Exif\0\0"), or nil.
func ReadExif(path string) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxExifScan))
	if err != nil {
		return nil
	}
	return exifFrom(b)
}

func exifFrom(b []byte) []byte {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return nil
	}
	i := 2
	for i+4 <= len(b) {
		if b[i] != 0xFF {
			return nil
		}
		m := b[i+1]
		if m == 0xFF { // fill byte
			i++
			continue
		}
		if m == 0xDA || m == 0xD9 { // image data starts
			return nil
		}
		n := int(binary.BigEndian.Uint16(b[i+2 : i+4]))
		if n < 2 || i+2+n > len(b) {
			return nil
		}
		seg := b[i+4 : i+2+n]
		if m == 0xE1 && bytes.HasPrefix(seg, []byte("Exif\x00\x00")) {
			return append([]byte(nil), seg...)
		}
		i += 2 + n
	}
	return nil
}

// resetOrientation sets the orientation tag (0x0112) of an Exif payload to 1.
// It returns false when the payload can't be read.
func resetOrientation(exif []byte) bool {
	if len(exif) < 6+8 {
		return false
	}
	t := exif[6:]
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return false
	}
	if bo.Uint16(t[2:4]) != 42 {
		return false
	}
	ifd := int(bo.Uint32(t[4:8]))
	if ifd < 8 || ifd+2 > len(t) {
		return false
	}
	count := int(bo.Uint16(t[ifd : ifd+2]))
	for e := 0; e < count; e++ {
		p := ifd + 2 + e*12
		if p+12 > len(t) {
			return false
		}
		if bo.Uint16(t[p:p+2]) == 0x0112 {
			bo.PutUint16(t[p+8:p+10], 1)
			return true
		}
	}
	return true // no orientation tag: nothing to reset
}

// InjectExif returns jpeg with the Exif payload inserted as an APP1 segment
// after SOI and any JFIF APP0 segment. The input is returned unchanged when
// it isn't a JPEG or the payload is unusable.
func InjectExif(jpeg, exif []byte) []byte {
	if len(exif) == 0 || len(exif)+2 > 0xFFFF || len(jpeg) < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
		return jpeg
	}
	exif = append([]byte(nil), exif...)
	if !resetOrientation(exif) {
		return jpeg
	}
	at := 2
	if jpeg[2] == 0xFF && jpeg[3] == 0xE0 && len(jpeg) >= 6 {
		at = 2 + 2 + int(binary.BigEndian.Uint16(jpeg[4:6]))
		if at > len(jpeg) {
			return jpeg
		}
	}
	seg := make([]byte, 0, len(exif)+4)
	seg = append(seg, 0xFF, 0xE1)
	seg = binary.BigEndian.AppendUint16(seg, uint16(len(exif)+2))
	seg = append(seg, exif...)
	out := make([]byte, 0, len(jpeg)+len(seg))
	out = append(out, jpeg[:at]...)
	out = append(out, seg...)
	return append(out, jpeg[at:]...)
}
