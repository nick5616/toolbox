package organize

import (
	"encoding/base64"
	"fmt"
	"image"
	_ "image/jpeg" // thumbnails come back as JPEG or PNG data URLs
	_ "image/png"
	"strings"

	"toolbox/core/imaging"
)

// photoHash is core/imaging.DHash (moved there in Phase 20 so Smart search
// can dedupe video frames with it).
type photoHash = imaging.DHash

// dHashImage computes the 9x8 difference hash (imaging.DHashImage).
func dHashImage(img image.Image) photoHash { return imaging.DHashImage(img) }

// dataURLImage decodes a "data:image/...;base64,..." URL.
func dataURLImage(url string) (image.Image, error) {
	_, payload, ok := strings.Cut(url, ",")
	if !ok {
		return nil, fmt.Errorf("not a data URL")
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("decode data URL: %w", err)
	}
	img, _, err := image.Decode(strings.NewReader(string(raw)))
	if err != nil {
		return nil, fmt.Errorf("decode thumbnail: %w", err)
	}
	return img, nil
}

// fileHash hashes a photo from a small decoded thumbnail (core/imaging reads
// orientation and HEIC, and bounds big files).
func fileHash(path string) (photoHash, error) {
	url, err := imaging.ThumbUncached(path, imaging.MinThumbDim)
	if err != nil {
		return photoHash{}, err
	}
	img, err := dataURLImage(url)
	if err != nil {
		return photoHash{}, err
	}
	return dHashImage(img), nil
}

// photoPixels is a photo's displayed pixel count (0 when unreadable).
func photoPixels(path string) (w, h int) {
	s, err := imaging.Size(path)
	if err != nil {
		return 0, 0
	}
	return s.W, s.H
}
