package imaging

import (
	"image"
	"math/bits"
)

// DHash is a 64-bit difference hash of a picture plus its average
// brightness (a guard: flat pictures of different colours all hash to 0).
// Shared by Organizer's look-alikes and Smart search's video frame dedupe.
type DHash struct {
	Bits uint64
	Mean uint8
}

// maxMeanGap is the largest brightness difference Alike accepts.
const maxMeanGap = 32

// Distance is the number of differing hash bits.
func (a DHash) Distance(b DHash) int { return bits.OnesCount64(a.Bits ^ b.Bits) }

// Alike reports whether two hashes are within dist bits and similar brightness.
func (a DHash) Alike(b DHash, dist int) bool {
	if a.Distance(b) > dist {
		return false
	}
	d := int(a.Mean) - int(b.Mean)
	return d <= maxMeanGap && -d <= maxMeanGap
}

// DHashImage computes the 9x8 difference hash: each cell is the average
// brightness of its share of the picture; each bit says whether a cell is
// brighter than its right neighbour.
func DHashImage(img image.Image) DHash {
	const cols, rows = 9, 8
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return DHash{}
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
	return DHash{Bits: hash, Mean: uint8(total / float64(rows*cols))}
}
