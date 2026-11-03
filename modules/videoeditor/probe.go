package videoeditor

import (
	"context"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"toolbox/core/imaging"
	"toolbox/core/media"
)

// Seams for tests.
var probeMedia = media.Probe

// kindByExt classifies a file by its extension: photos are never probed with
// FFmpeg (HEIC can't be).
func kindByExt(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if slices.Contains(media.ImageExtensions(), ext) {
		return "image"
	}
	return ""
}

// ProbeFiles describes source files in order (Edit Studio uses it). A file
// that can't be read still gets a row, with Error set.
func ProbeFiles(ctx context.Context, ffprobe string, paths []string) []ClipInfo {
	out := make([]ClipInfo, 0, len(paths))
	for _, p := range paths {
		out = append(out, probeFile(ctx, ffprobe, p))
	}
	return out
}

// probeFile describes one source file. Failures go into ClipInfo.Error.
func probeFile(ctx context.Context, ffprobe, path string) ClipInfo {
	ci := ClipInfo{Path: path}
	fi, err := os.Stat(path)
	if err != nil {
		ci.Error = "This file doesn't exist any more"
		return ci
	}
	mtime := fi.ModTime().UnixMilli()

	if kindByExt(path) == "image" {
		ci.Kind = "image"
		if sz, err := imaging.Size(path); err == nil {
			ci.Width, ci.Height = sz.W, sz.H // already upright (EXIF orientation, HEIC rotation)
		}
		ci.TakenAt = exifTakenAt(path)
		if ci.TakenAt == 0 {
			ci.TakenAt = mtime
		}
		return ci
	}

	info, err := probeMedia(ctx, ffprobe, path)
	if err != nil {
		ci.Error = "Couldn't read this file"
		if ctx.Err() != nil {
			ci.Error = "Cancelled"
		}
		return ci
	}
	ci.DurationMs = info.DurationMs
	ci.HasAudio = len(info.Audio) > 0
	switch {
	case info.Video != nil:
		ci.Kind = "video"
		ci.Width, ci.Height, ci.FPS, ci.Rotation = info.Video.Width, info.Video.Height, info.Video.FPS, info.Video.Rotation
	case len(info.Audio) > 0:
		ci.Kind = "audio"
	default:
		ci.Error = "This file has no picture or sound"
		return ci
	}
	ci.TakenAt = tagTakenAt(info.Tags)
	if ci.TakenAt == 0 {
		ci.TakenAt = mtime
	}
	return ci
}

// tagTakenAt reads the container's creation time (Unix ms; 0 = none).
func tagTakenAt(tags map[string]string) int64 {
	for _, k := range []string{"com.apple.quicktime.creationdate", "creation_time"} {
		v := tags[k]
		if v == "" {
			continue
		}
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05-0700", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(layout, v); err == nil && t.Year() > 1971 {
				return t.UnixMilli()
			}
		}
	}
	return 0
}

// exifTakenAt reads DateTimeOriginal from a JPEG's Exif block (local time;
// Unix ms; 0 = none). It's a minimal reader: APP1 → TIFF → Exif IFD.
func exifTakenAt(path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	head := make([]byte, 2)
	if _, err := io.ReadFull(f, head); err != nil || head[0] != 0xFF || head[1] != 0xD8 {
		return 0
	}
	for {
		var m [4]byte
		if _, err := io.ReadFull(f, m[:]); err != nil || m[0] != 0xFF {
			return 0
		}
		size := int(binary.BigEndian.Uint16(m[2:]))
		if size < 2 {
			return 0
		}
		if m[1] == 0xDA || m[1] == 0xD9 { // image data: no Exif before it
			return 0
		}
		seg := make([]byte, size-2)
		if _, err := io.ReadFull(f, seg); err != nil {
			return 0
		}
		if m[1] == 0xE1 && len(seg) > 6 && string(seg[:6]) == "Exif\x00\x00" {
			return exifDate(seg[6:])
		}
	}
}

// exifDate finds DateTimeOriginal (0x9003) in a TIFF block.
func exifDate(t []byte) int64 {
	if len(t) < 8 {
		return 0
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0
	}
	// ifd calls fn for each entry of the IFD at off.
	ifd := func(off uint32, fn func(tag, typ uint16, count, val uint32)) {
		if int(off)+2 > len(t) {
			return
		}
		n := int(bo.Uint16(t[off:]))
		for i := 0; i < n; i++ {
			e := int(off) + 2 + i*12
			if e+12 > len(t) {
				return
			}
			fn(bo.Uint16(t[e:]), bo.Uint16(t[e+2:]), bo.Uint32(t[e+4:]), bo.Uint32(t[e+8:]))
		}
	}
	var exifOff uint32
	ifd(bo.Uint32(t[4:]), func(tag, _ uint16, _, val uint32) {
		if tag == 0x8769 {
			exifOff = val
		}
	})
	if exifOff == 0 {
		return 0
	}
	var out int64
	ifd(exifOff, func(tag, typ uint16, count, val uint32) {
		if tag != 0x9003 || typ != 2 || count < 19 || int(val)+19 > len(t) || out != 0 {
			return
		}
		if tm, err := time.ParseInLocation("2006:01:02 15:04:05", string(t[val:val+19]), time.Local); err == nil {
			out = tm.UnixMilli()
		}
	})
	return out
}
