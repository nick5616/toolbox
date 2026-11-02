package imaging

import "image"

// EXIF orientation (SPEC.md Part B §B0.2). CONTRACT STUB (Wave B0): the
// signatures are final; WP-CO1 implements them.

// Orientation returns the EXIF orientation (1–8) of a JPEG or TIFF file; 1
// when there is none or it can't be read.
func Orientation(path string) int { return 1 }

// Orient returns img transformed for EXIF orientation o (1 = unchanged).
func Orient(img image.Image, o int) image.Image { return img }
