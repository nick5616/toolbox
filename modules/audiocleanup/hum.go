package audiocleanup

import (
	"encoding/binary"
	"math"
)

// Hum detection (SPEC.md §6.2 step 2): Goertzel energy at the mains
// fundamental versus its neighbours, on 4 kHz mono audio.

const (
	humSampleRate = 4000
	// humDetectSeconds is how much audio from the middle of the file is analysed.
	humDetectSeconds = 30
	// humMinDB is how far the fundamental must stand above its neighbours.
	humMinDB = 10.0
	// humMinSamples is the least audio worth analysing (2 s).
	humMinSamples = 2 * humSampleRate
)

// goertzelPower is the power of the bin at freq (Hz) for the windowed samples.
func goertzelPower(x []float64, rate, freq float64) float64 {
	w := 2 * math.Pi * freq / rate
	coeff := 2 * math.Cos(w)
	var s1, s2 float64
	for _, v := range x {
		s := v + coeff*s1 - s2
		s2, s1 = s1, s
	}
	p := s1*s1 + s2*s2 - coeff*s1*s2
	return max(p, 0) / float64(len(x)*len(x))
}

// humScore is the fundamental's level over the mean of its neighbours
// (±4 and ±8 Hz) in dB.
func humScore(x []float64, rate, f float64) float64 {
	fund := goertzelPower(x, rate, f)
	var nb float64
	for _, d := range []float64{-8, -4, 4, 8} {
		nb += goertzelPower(x, rate, f+d)
	}
	nb /= 4
	return 10 * math.Log10((fund+1e-20)/(nb+1e-20))
}

// detectHum returns 50, 60 or 0 for mono samples at humSampleRate.
func detectHum(pcm []int16) int {
	if len(pcm) < humMinSamples {
		return 0
	}
	x := make([]float64, len(pcm))
	n := float64(len(pcm) - 1)
	for i, v := range pcm {
		hann := 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/n)
		x[i] = float64(v) / 32768 * hann
	}
	best, bestScore := 0, humMinDB
	for _, f := range []int{50, 60} {
		if s := humScore(x, humSampleRate, float64(f)); s >= bestScore {
			best, bestScore = f, s
		}
	}
	return best
}

// decodeS16LE converts raw little-endian 16-bit mono samples.
func decodeS16LE(b []byte) []int16 {
	out := make([]int16, len(b)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[2*i:]))
	}
	return out
}
