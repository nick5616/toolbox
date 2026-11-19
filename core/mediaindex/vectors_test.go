package mediaindex

import (
	"context"
	"math"
	"math/rand"
	"sort"
	"testing"
)

func randUnit(r *rand.Rand, dim int) []float32 {
	v := make([]float32, dim)
	for i := range v {
		v[i] = float32(r.NormFloat64())
	}
	return Normalize(v)
}

func TestFP16RoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	maxErr := 0.0
	for i := 0; i < 200; i++ {
		v := randUnit(r, 768)
		got := DecodeVec(EncodeVec(v))
		for j := range v {
			maxErr = math.Max(maxErr, math.Abs(float64(v[j]-got[j])))
		}
	}
	if maxErr > 1e-3 {
		t.Fatalf("max round-trip error %g", maxErr)
	}
	for _, f := range []float32{0, 1, -1, 0.5, 65504, -65504, 6.1e-5, 1e-7} {
		g := f16ToF32(f32ToF16(f))
		if math.Abs(float64(g-f)) > math.Abs(float64(f))*1e-3+1e-7 {
			t.Errorf("%g -> %g", f, g)
		}
	}
	if !math.IsInf(float64(f16ToF32(f32ToF16(float32(math.Inf(1))))), 1) || !math.IsInf(float64(f16ToF32(f32ToF16(1e9))), 1) {
		t.Error("infinity not kept")
	}
	if !math.IsNaN(float64(f16ToF32(f32ToF16(float32(math.NaN()))))) {
		t.Error("NaN not kept")
	}
	if len(EncodeVec(make([]float32, 5))) != 10 {
		t.Error("two bytes per value")
	}
}

func TestProbAndMinCos(t *testing.T) {
	m := Model{Scale: 112.6689, Bias: -16.7717247}
	for _, p := range []float64{StrongP, GoodP, MaybeP} {
		if got := ProbFromCos(m, MinCos(m, p)); math.Abs(got-p) > 1e-9 {
			t.Errorf("p=%g round trip %g", p, got)
		}
	}
	if StrengthForP(0.5) != "strong" || StrengthForP(0.2) != "good" || StrengthForP(0.05) != "maybe" || StrengthForP(0.01) != "" {
		t.Error("strength cut-offs")
	}
}

func TestMatrixScanMatchesNaive(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	const dim, n = 16, 9000 // more than two chunks
	m := &matrix{dim: dim}
	type row struct {
		item, pos int64
		vec       []float32
	}
	var rows []row
	for i := 0; i < n; i++ {
		item := int64(i/3 + 1) // three vectors per item
		v := randUnit(r, dim)
		m.add(item, int64(i%3)*1000, v)
		rows = append(rows, row{item, int64(i%3) * 1000, v})
	}
	// Remove a few items, like StoreBatch does.
	m.remove(map[int64]bool{5: true, 77: true, 2999: true})
	var live []row
	for _, rw := range rows {
		if rw.item != 5 && rw.item != 77 && rw.item != 2999 {
			live = append(live, rw)
		}
	}
	queries := [][]float32{randUnit(r, dim), randUnit(r, dim)}
	const minCos = 0.3
	got, err := m.scan(context.Background(), queries, minCos, 10)
	if err != nil {
		t.Fatal(err)
	}
	type key struct{ item, pos int64 }
	want := map[key]float32{}
	for _, rw := range live {
		if rw.item == 10 {
			continue
		}
		best := float32(-2)
		for _, q := range queries {
			var d float32
			for i := range q {
				d += q[i] * rw.vec[i]
			}
			best = float32(math.Max(float64(best), float64(d)))
		}
		if best >= minCos {
			want[key{rw.item, rw.pos}] = best
		}
	}
	if len(got) != len(want) {
		t.Fatalf("rows: got %d want %d", len(got), len(want))
	}
	for _, g := range got {
		w, ok := want[key{g.item, g.pos}]
		if !ok || math.Abs(float64(w-g.cos)) > 1e-5 {
			t.Fatalf("row %+v: want %v ok=%v", g, w, ok)
		}
	}
	// compaction keeps the answer
	m.compact()
	again, _ := m.scan(context.Background(), queries, minCos, 10)
	if len(again) != len(got) {
		t.Fatalf("after compact: %d vs %d", len(again), len(got))
	}
}

func TestFoldByItem(t *testing.T) {
	rows := []rowScore{{1, 0, 0.5}, {1, 100, 0.9}, {1, 200, 0.7}, {2, -1, 0.8}, {1, 300, 0.1}}
	got := foldByItem(rows, 2)
	if len(got) != 2 || got[0].item != 1 || got[0].pos != 100 || got[0].cos != 0.9 {
		t.Fatalf("fold: %+v", got)
	}
	if len(got[0].moments) != 2 || got[0].moments[0] != 200 || got[0].moments[1] != 0 {
		t.Fatalf("moments best first, capped: %v", got[0].moments)
	}
	if got[1].item != 2 || len(got[1].moments) != 0 {
		t.Fatalf("second: %+v", got[1])
	}
	if !sort.SliceIsSorted(got, func(i, j int) bool { return got[i].cos > got[j].cos }) {
		t.Fatal("not sorted by score")
	}
}
