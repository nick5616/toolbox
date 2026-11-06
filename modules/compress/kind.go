package compress

import (
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core/media"
)

// ImageExtensions are the photo inputs (re-encoded, scaled only if needed).
func ImageExtensions() []string {
	return []string{".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
}

// OfficeExtensions are the Office files whose pictures are recompressed.
func OfficeExtensions() []string { return []string{".docx", ".pptx", ".xlsx"} }

// KindOf decides how a file is compressed, by extension. A single-frame GIF
// is still KindGIF here; the GIF runner treats it as a photo.
func KindOf(path string) Kind {
	ext := strings.ToLower(filepath.Ext(path))
	switch {
	case slices.Contains(media.VideoExtensions(), ext):
		return KindVideo
	case slices.Contains(media.AudioExtensions(), ext):
		return KindAudio
	case ext == ".gif":
		return KindGIF
	case slices.Contains(ImageExtensions(), ext):
		return KindImage
	case ext == ".pdf":
		return KindPDF
	case slices.Contains(OfficeExtensions(), ext):
		return KindOffice
	}
	return KindOther
}

// needsFFmpeg reports whether a kind always needs FFmpeg.
func needsFFmpeg(k Kind) bool { return k == KindVideo || k == KindAudio || k == KindGIF }
