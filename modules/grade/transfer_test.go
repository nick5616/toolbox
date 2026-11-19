package grade

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func solid(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func TestBandWeightsSumToOne(t *testing.T) {
	for l := 0.0; l <= 100; l += 2.5 {
		s, m, h := BandWeights(l)
		if math.Abs(s+m+h-1) > 1e-9 || s < 0 || m < 0 || h < 0 {
			t.Errorf("L=%v: %v %v %v", l, s, m, h)
		}
	}
	if s, _, _ := BandWeights(0); s != 1 {
		t.Error("black isn't all shadow")
	}
	if _, _, h := BandWeights(100); h != 1 {
		t.Error("white isn't all highlight")
	}
	if _, m, _ := BandWeights(50); m != 1 {
		t.Error("mid grey isn't all midtone")
	}
}

func TestRGBToLabKnownValues(t *testing.T) {
	for _, tc := range []struct {
		r, g, b  float64
		l, a, bb float64
		tolL     float64
		tolAB    float64
	}{
		{0, 0, 0, 0, 0, 0, 0.01, 0.01},
		{1, 1, 1, 100, 0, 0, 0.05, 0.05},
		{1, 0, 0, 53.24, 80.09, 67.20, 0.1, 0.3},
		{0, 1, 0, 87.73, -86.18, 83.18, 0.1, 0.3},
		{0, 0, 1, 32.30, 79.19, -107.86, 0.1, 0.3},
	} {
		l, a, b := rgbToLab(tc.r, tc.g, tc.b)
		if math.Abs(l-tc.l) > tc.tolL || math.Abs(a-tc.a) > tc.tolAB || math.Abs(b-tc.bb) > tc.tolAB {
			t.Errorf("rgb(%v,%v,%v) = Lab(%.2f, %.2f, %.2f), want (%.2f, %.2f, %.2f)", tc.r, tc.g, tc.b, l, a, b, tc.l, tc.a, tc.bb)
		}
	}
}

func TestTransferStatsOfSyntheticImages(t *testing.T) {
	// A flat mid grey: all weight in the mids, no spread; empty bands fall back to the global stats.
	grey := TransferStats(solid(32, 32, color.RGBA{119, 119, 119, 255}))
	if len(grey) != 18 {
		t.Fatalf("%d numbers", len(grey))
	}
	for band := 0; band < 3; band++ {
		if l := grey[band*6]; math.Abs(l-50) > 1 {
			t.Errorf("band %d mean L = %.2f", band, l)
		}
		for _, i := range []int{1, 2, 3, 4, 5} {
			if math.Abs(grey[band*6+i]) > 0.1 {
				t.Errorf("band %d stat %d = %.3f, want ~0", band, i, grey[band*6+i])
			}
		}
	}

	// Half black, half white: shadows are black, highlights are white, both flat.
	bw := image.NewRGBA(image.Rect(0, 0, 40, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 40; x++ {
			c := color.RGBA{0, 0, 0, 255}
			if x >= 20 {
				c = color.RGBA{255, 255, 255, 255}
			}
			bw.SetRGBA(x, y, c)
		}
	}
	got := TransferStats(bw)
	if got[0] > 1 || got[3] > 0.5 {
		t.Errorf("shadows mean L %.2f std %.2f", got[0], got[3])
	}
	if got[12] < 99 || got[15] > 0.5 {
		t.Errorf("highlights mean L %.2f std %.2f", got[12], got[15])
	}

	// A warm picture has a positive b in the mids; a cool one a negative b.
	if warm := TransferStats(solid(8, 8, color.RGBA{200, 140, 90, 255})); warm[2] <= 5 {
		t.Errorf("warm b = %.2f", warm[2])
	}
	if cool := TransferStats(solid(8, 8, color.RGBA{90, 130, 200, 255})); cool[2] >= -5 {
		t.Errorf("cool b = %.2f", cool[2])
	}
}

func TestTransferStatsSkipsTransparentPixels(t *testing.T) {
	got := TransferStats(image.NewNRGBA(image.Rect(0, 0, 10, 10)))
	for _, v := range got {
		if v != 0 {
			t.Fatalf("stats of nothing = %v", got)
		}
	}
}

func TestServiceTransfer(t *testing.T) {
	m := newModule(t, nil, nil)
	dir := t.TempDir()
	ref := filepath.Join(dir, "ref.png")
	f, _ := os.Create(ref)
	if err := png.Encode(f, solid(16, 16, color.RGBA{200, 140, 90, 255})); err != nil {
		t.Fatal(err)
	}
	f.Close()
	stats, err := m.Transfer(context.Background(), ref)
	if err != nil || len(stats) != 18 {
		t.Fatalf("%v, %v", stats, err)
	}
	if _, err := m.Transfer(context.Background(), filepath.Join(dir, "clip.mp4")); err == nil {
		t.Error("a video was accepted as a reference")
	}
	if _, err := m.Transfer(context.Background(), filepath.Join(dir, "missing.png")); err == nil {
		t.Error("a missing file was accepted")
	}
	// The numbers are valid transfer params.
	b, _ := json.Marshal(stats)
	op := Op{ID: "aaaaaa", Kind: "transfer", On: true, Amount: 1, Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{"stats": b}}
	got, err := Normalize(recipeWith(op))
	if err != nil || len(got.Ops[0].Params) != 1 {
		t.Errorf("transfer stats were rejected: %v %v", got.Ops, err)
	}
}
