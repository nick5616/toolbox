package organize

import (
	"encoding/base64"
	"fmt"
	"image"
	_ "image/jpeg" // thumbnails come back as JPEG or PNG data URLs
	_ "image/png"
	"math/bits"
	"strings"

	"toolbox/core/imaging"
)

// photoHash is a 64-bit difference hash of a picture plus its average
// brightness (a guard: flat pictures of different colours all hash to 0).
type photoHash struct {
	Bits uint64
	Mean uint8
}

const maxMeanGap = 32

// alike reports whether two hashes are within dist bits and similar brightness.
func (a photoHash) alike(b photoHash, dist int) bool {
	if bits.OnesCount64(a.Bits^b.Bits) > dist {
		return false
	}
	d := int(a.Mean) - int(b.Mean)
	return d <= maxMeanGap && -d <= maxMeanGap
}

// dHashImage computes the 9x8 difference hash: each cell is the average
// brightness of its share of the picture; each bit says whether a cell is
// brighter than its right neighbour.
func dHashImage(img image.Image) photoHash {
	const cols, rows = 9, 8
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return photoHash{}
	}
	var sum [rows][cols]float64
	var cnt [rows][cols]float64
	for y := 0; y < h; y++ {
		cy := y * rows / h
		for x := 0; x < w; x++ {
			cx := x * cols / w
			r, g, bl, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			// Composite over white so transparent areas don't read as black.
			af := float64(a) / 65535
			lum := 0.299*float64(r) + 0.587*float64(g) + 0.114*float64(bl)
			lum = lum/257 + (1-af)*255
			sum[cy][cx] += lum
			cnt[cy][cx]++
		}
	}
	var cell [rows][cols]float64
	var total float64
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			if cnt[y][x] > 0 {
				cell[y][x] = sum[y][x] / cnt[y][x]
			}
			total += cell[y][x]
		}
	}
	var hash uint64
	for y := 0; y < rows; y++ {
		for x := 0; x < cols-1; x++ {
			hash <<= 1
			if cell[y][x] > cell[y][x+1] {
				hash |= 1
			}
		}
	}
	return photoHash{Bits: hash, Mean: uint8(total / float64(rows*cols))}
}

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
