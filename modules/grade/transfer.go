package grade

import (
	"context"
	"image"
	"math"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/imaging"
)

// Steal a look (SPEC §E1): the reference's Lab statistics per luma band. The
// frontend's `transfer` op matches a picture's mean and standard deviation to
// these (Reinhard per band with the same soft weights, see BandWeights).

// transferSamples is the most pixels sampled from a reference.
const transferSamples = 400_000

// BandWeights are the soft weights (shadows, mids, highlights) of a pixel
// with Lab lightness l (0..100). They sum to 1. frontend/src/grade/math.ts
// uses the same function.
func BandWeights(l float64) (shadows, mids, highlights float64) {
	t := clamp(l/100, 0, 1)
	shadows = 1 - smoothstep(0.25, 0.5, t)
	highlights = smoothstep(0.5, 0.75, t)
	return shadows, 1 - shadows - highlights, highlights
}

func smoothstep(a, b, x float64) float64 {
	t := clamp((x-a)/(b-a), 0, 1)
	return t * t * (3 - 2*t)
}

func srgbToLinear(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

// rgbToLab converts sRGB 0..1 to CIE Lab (D65).
func rgbToLab(r, g, b float64) (l, a, bb float64) {
	r, g, b = srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)
	x := (0.4124564*r + 0.3575761*g + 0.1804375*b) / 0.95047
	y := 0.2126729*r + 0.7151522*g + 0.0721750*b
	z := (0.0193339*r + 0.1191920*g + 0.9503041*b) / 1.08883
	f := func(t float64) float64 {
		if t > 216.0/24389 {
			return math.Cbrt(t)
		}
		return (24389.0/27*t + 16) / 116
	}
	fx, fy, fz := f(x), f(y), f(z)
	return 116*fy - 16, 500 * (fx - fy), 200 * (fy - fz)
}

// TransferStats computes the 18 numbers of an image: for each band (shadows,
// mids, highlights) the weighted Lab mean (L, a, b) then standard deviation
// (L, a, b).
func TransferStats(img image.Image) []float64 {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	step := 1
	for (w/step)*(h/step) > transferSamples {
		step++
	}
	var wsum [3]float64
	var sums [3][3]float64
	var sqs [3][3]float64
	var gsum, gsq [3]float64
	var gn float64
	for y := b.Min.Y; y < b.Max.Y; y += step {
		for x := b.Min.X; x < b.Max.X; x += step {
			r, g, bl, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}
			af := float64(a)
			l, la, lb := rgbToLab(float64(r)/af, float64(g)/af, float64(bl)/af)
			lab := [3]float64{l, la, lb}
			ws, wm, wh := BandWeights(l)
			for bi, wt := range [3]float64{ws, wm, wh} {
				if wt <= 0 {
					continue
				}
				wsum[bi] += wt
				for c := 0; c < 3; c++ {
					sums[bi][c] += wt * lab[c]
					sqs[bi][c] += wt * lab[c] * lab[c]
				}
			}
			gn++
			for c := 0; c < 3; c++ {
				gsum[c] += lab[c]
				gsq[c] += lab[c] * lab[c]
			}
		}
	}
	out := make([]float64, 18)
	for bi := 0; bi < 3; bi++ {
		for c := 0; c < 3; c++ {
			var mean, std float64
			switch {
			case wsum[bi] > 1e-6:
				mean = sums[bi][c] / wsum[bi]
				std = math.Sqrt(math.Max(sqs[bi][c]/wsum[bi]-mean*mean, 0))
			case gn > 0:
				mean = gsum[c] / gn
				std = math.Sqrt(math.Max(gsq[c]/gn-mean*mean, 0))
			}
			out[bi*6+c], out[bi*6+3+c] = mean, std
		}
	}
	return out
}

// Transfer returns the transfer op's "stats" param for a reference picture.
func (m *Module) Transfer(ctx context.Context, refPath string) ([]float64, error) {
	if err := core.ValidateFileInputs([]string{refPath}, imageOnly()); err != nil {
		return nil, err
	}
	readable, err := imaging.ToReadable(ctx, refPath)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(readable)
	if err != nil {
		return nil, core.Errorf(core.CodeNotFound, "This picture doesn't exist any more").WithCause(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "Couldn't read this picture").WithHint(filepath.Base(refPath)).WithCause(err)
	}
	if int64(cfg.Width)*int64(cfg.Height) > imaging.MaxPixels {
		return nil, core.Errorf(core.CodeValidation, "This picture is too large").WithHint(filepath.Base(refPath))
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "Couldn't read this picture").WithHint(filepath.Base(refPath)).WithCause(err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return TransferStats(img), nil
}

func imageOnly() []string {
	var out []string
	for _, e := range Accepts() {
		if !isVideoExt(e) {
			out = append(out, e)
		}
	}
	return out
}
