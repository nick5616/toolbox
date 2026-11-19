package mediaindex

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"toolbox/core/par"
)

// Vectors: the float16 codec, the in-memory matrix of current-model vectors
// and the parallel dot products (SPEC.md §3.6).

const (
	// matrixChunk is how many rows one dot-product task handles.
	matrixChunk = 4096
	// DefaultMatrixCap is the memory cap of the in-memory matrix; above it
	// the index streams vectors from SQLite instead.
	DefaultMatrixCap = 512 << 20
	// matrixIdle is how long an unused matrix stays in memory.
	matrixIdle = 10 * time.Minute
)

// f32ToF16 converts to IEEE 754 half precision, rounding to nearest even.
func f32ToF16(f float32) uint16 {
	b := math.Float32bits(f)
	sign := uint16(b>>16) & 0x8000
	e := int32(b>>23) & 0xff
	mant := b & 0x7fffff
	if e == 0xff { // inf, NaN
		if mant != 0 {
			return sign | 0x7e00
		}
		return sign | 0x7c00
	}
	exp := e - 127 + 15
	switch {
	case exp >= 31:
		return sign | 0x7c00
	case exp <= 0:
		if exp < -10 {
			return sign
		}
		mant |= 0x800000
		shift := uint(14 - exp)
		half := uint16(mant >> shift)
		rem := mant & (1<<shift - 1)
		halfway := uint32(1) << (shift - 1)
		if rem > halfway || (rem == halfway && half&1 == 1) {
			half++
		}
		return sign | half
	default:
		half := uint16(exp)<<10 | uint16(mant>>13)
		rem := mant & 0x1fff
		if rem > 0x1000 || (rem == 0x1000 && half&1 == 1) {
			half++ // a carry into the exponent is correct
		}
		return sign | half
	}
}

// f16ToF32 converts from half precision.
func f16ToF32(h uint16) float32 {
	sign := uint32(h&0x8000) << 16
	exp := uint32(h>>10) & 0x1f
	mant := uint32(h & 0x3ff)
	switch exp {
	case 0:
		v := float32(mant) / 16777216 // mant · 2^-24
		if sign != 0 {
			return -v
		}
		return v
	case 31:
		return math.Float32frombits(sign | 0x7f800000 | mant<<13)
	default:
		return math.Float32frombits(sign | (exp-15+127)<<23 | mant<<13)
	}
}

// EncodeVec packs a vector as float16 little-endian (the stored format).
func EncodeVec(v []float32) []byte {
	out := make([]byte, 2*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint16(out[2*i:], f32ToF16(f))
	}
	return out
}

// DecodeVec unpacks a float16 little-endian blob.
func DecodeVec(b []byte) []float32 {
	out := make([]float32, len(b)/2)
	decodeInto(out, b)
	return out
}

func decodeInto(dst []float32, b []byte) {
	for i := range dst {
		dst[i] = f16ToF32(binary.LittleEndian.Uint16(b[2*i:]))
	}
}

// Dot is the dot product of two equal-length vectors.
func Dot(a, b []float32) float32 {
	n := min(len(a), len(b))
	var s0, s1, s2, s3 float32
	i := 0
	for ; i+4 <= n; i += 4 {
		s0 += a[i] * b[i]
		s1 += a[i+1] * b[i+1]
		s2 += a[i+2] * b[i+2]
		s3 += a[i+3] * b[i+3]
	}
	for ; i < n; i++ {
		s0 += a[i] * b[i]
	}
	return s0 + s1 + s2 + s3
}

// Normalize scales v to unit length in place (a zero vector is left alone).
func Normalize(v []float32) []float32 {
	var s float64
	for _, f := range v {
		s += float64(f) * float64(f)
	}
	if s == 0 {
		return v
	}
	inv := float32(1 / math.Sqrt(s))
	for i := range v {
		v[i] *= inv
	}
	return v
}

// Sigmoid is 1/(1+e^-x).
func Sigmoid(x float64) float64 { return 1 / (1 + math.Exp(-x)) }

// ProbFromCos is the model's probability for a cosine similarity.
func ProbFromCos(m Model, cos float64) float64 { return Sigmoid(m.Scale*cos + m.Bias) }

// MinCos is the cosine at which the probability equals p (the inverse of ProbFromCos).
func MinCos(m Model, p float64) float64 {
	if m.Scale == 0 {
		return -1
	}
	return (math.Log(p/(1-p)) - m.Bias) / m.Scale
}

// rowScore is one vector's score against a query.
type rowScore struct {
	item, pos int64
	cos       float32
}

// matrix is the in-memory fp32 copy of the current model's vectors. Dead
// rows (item 0) are skipped and compacted away when they pile up.
type matrix struct {
	dim  int
	data []float32
	item []int64
	pos  []int64
	dead int
}

func (m *matrix) rows() int { return len(m.item) }

func (m *matrix) add(item, pos int64, vec []float32) {
	if len(vec) != m.dim {
		return
	}
	m.data = append(m.data, vec...)
	m.item = append(m.item, item)
	m.pos = append(m.pos, pos)
}

func (m *matrix) remove(ids map[int64]bool) {
	for i, it := range m.item {
		if it != 0 && ids[it] {
			m.item[i] = 0
			m.dead++
		}
	}
	if m.dead > 1024 && m.dead > len(m.item)/4 {
		m.compact()
	}
}

func (m *matrix) compact() {
	w := 0
	for r := range m.item {
		if m.item[r] == 0 {
			continue
		}
		if w != r {
			copy(m.data[w*m.dim:(w+1)*m.dim], m.data[r*m.dim:(r+1)*m.dim])
			m.item[w], m.pos[w] = m.item[r], m.pos[r]
		}
		w++
	}
	m.data = m.data[:w*m.dim]
	m.item, m.pos = m.item[:w], m.pos[:w]
	m.dead = 0
}

// scan scores every live row against the queries (max over queries) in
// parallel chunks, keeping rows with cos ≥ minCos.
func (m *matrix) scan(ctx context.Context, queries [][]float32, minCos float32, exclude int64) ([]rowScore, error) {
	n := m.rows()
	chunks := (n + matrixChunk - 1) / matrixChunk
	parts, err := par.Map(ctx, chunks, par.CPUHalf(), func(_ context.Context, c int) ([]rowScore, error) {
		lo, hi := c*matrixChunk, min((c+1)*matrixChunk, n)
		var out []rowScore
		for r := lo; r < hi; r++ {
			it := m.item[r]
			if it == 0 || it == exclude {
				continue
			}
			row := m.data[r*m.dim : (r+1)*m.dim]
			best := float32(-2)
			for _, q := range queries {
				if d := Dot(row, q); d > best {
					best = d
				}
			}
			if best >= minCos {
				out = append(out, rowScore{it, m.pos[r], best})
			}
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	var all []rowScore
	for _, p := range parts {
		all = append(all, p...)
	}
	return all, nil
}

// vecIndex lazily holds the matrix for one model.
type vecIndex struct {
	mu        sync.Mutex // guards the fields; scans run on a snapshot under RLock
	rw        sync.RWMutex
	m         *matrix
	model     string
	streaming bool
	loaded    bool
	last      time.Time
}

func (v *vecIndex) drop() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.rw.Lock()
	v.m, v.loaded, v.streaming, v.model = nil, false, false, ""
	v.rw.Unlock()
}

func (v *vecIndex) idleFor(now time.Time) time.Duration {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.loaded {
		return 0
	}
	return now.Sub(v.last)
}

// scoreVectors scores every current-model vector against the queries and
// returns the rows with cos ≥ minCos. It loads the matrix on first use, or
// streams from SQLite when the matrix would exceed the cap.
func (ix *Index) scoreVectors(ctx context.Context, queries [][]float32, minCos float32, exclude int64) ([]rowScore, error) {
	model := ix.Model()
	if model.ID == "" || len(queries) == 0 {
		return nil, nil
	}
	for _, q := range queries {
		if len(q) != model.Dim {
			return nil, fmt.Errorf("query vector has %d values, model needs %d", len(q), model.Dim)
		}
	}
	v := &ix.vec
	v.mu.Lock()
	defer v.mu.Unlock() // one scan at a time keeps memory flat; scans are short
	if !v.loaded || v.model != model.ID {
		if err := ix.loadMatrix(ctx, model); err != nil {
			return nil, err
		}
	}
	v.rw.RLock()
	defer v.rw.RUnlock()
	v.last = ix.clock()
	if v.streaming {
		return ix.streamScan(ctx, model, queries, minCos, exclude)
	}
	return v.m.scan(ctx, queries, minCos, exclude)
}

// loadMatrix fills the matrix (caller holds v.mu).
func (ix *Index) loadMatrix(ctx context.Context, model Model) error {
	v := &ix.vec
	n, err := ix.cfg.Store.VectorCount(ctx, model.ID)
	if err != nil {
		return err
	}
	v.rw.Lock()
	defer v.rw.Unlock()
	v.model, v.loaded, v.last = model.ID, true, ix.clock()
	if int64(n)*int64(model.Dim)*4 > ix.matrixCapBytes() {
		v.m, v.streaming = nil, true
		return nil
	}
	m := &matrix{dim: model.Dim}
	m.data = make([]float32, 0, n*model.Dim)
	err = ix.cfg.Store.StreamVectors(ctx, model.ID, func(id, pos int64, blob []byte) error {
		if len(blob) != 2*model.Dim {
			return nil
		}
		start := len(m.data)
		m.data = append(m.data, make([]float32, model.Dim)...)
		decodeInto(m.data[start:], blob)
		m.item = append(m.item, id)
		m.pos = append(m.pos, pos)
		return nil
	})
	if err != nil {
		v.m, v.loaded = nil, false
		return err
	}
	v.m, v.streaming = m, false
	return nil
}

// streamScan scores straight from SQLite in chunks (the index is too large
// for memory).
func (ix *Index) streamScan(ctx context.Context, model Model, queries [][]float32, minCos float32, exclude int64) ([]rowScore, error) {
	var all []rowScore
	buf := &matrix{dim: model.Dim}
	flush := func() error {
		if buf.rows() == 0 {
			return nil
		}
		part, err := buf.scan(ctx, queries, minCos, exclude)
		if err != nil {
			return err
		}
		all = append(all, part...)
		buf.data, buf.item, buf.pos = buf.data[:0], buf.item[:0], buf.pos[:0]
		return nil
	}
	err := ix.cfg.Store.StreamVectors(ctx, model.ID, func(id, pos int64, blob []byte) error {
		if len(blob) != 2*model.Dim {
			return nil
		}
		start := len(buf.data)
		buf.data = append(buf.data, make([]float32, model.Dim)...)
		decodeInto(buf.data[start:], blob)
		buf.item = append(buf.item, id)
		buf.pos = append(buf.pos, pos)
		if buf.rows() >= matrixChunk*4 {
			return flush()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return all, flush()
}

// matrixStored keeps the matrix current after a write: the items' old rows
// go, the new vectors come in.
func (ix *Index) matrixStored(ids []int64, rows map[int64][]VectorAt) {
	v := &ix.vec
	v.rw.Lock()
	defer v.rw.Unlock()
	if !v.loaded || v.streaming || v.m == nil {
		return
	}
	gone := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id != 0 {
			gone[id] = true
		}
	}
	v.m.remove(gone)
	for id, vs := range rows {
		for _, x := range vs {
			v.m.add(id, x.Pos, x.Vec)
		}
	}
}

// matrixRemoved drops items from the matrix.
func (ix *Index) matrixRemoved(ids []int64) {
	if len(ids) == 0 {
		return
	}
	ix.matrixStored(ids, nil)
}

// bestPerItem folds row scores into one entry per item: the best cosine and
// its position, plus up to maxMoments other positions (best first).
type itemScore struct {
	item    int64
	cos     float32
	pos     int64
	moments []int64
}

func foldByItem(rows []rowScore, maxMoments int) []itemScore {
	by := map[int64][]rowScore{}
	for _, r := range rows {
		by[r.item] = append(by[r.item], r)
	}
	out := make([]itemScore, 0, len(by))
	for id, rs := range by {
		sort.Slice(rs, func(i, j int) bool {
			if rs[i].cos != rs[j].cos {
				return rs[i].cos > rs[j].cos
			}
			return rs[i].pos < rs[j].pos
		})
		is := itemScore{item: id, cos: rs[0].cos, pos: rs[0].pos}
		for _, r := range rs[1:] {
			if len(is.moments) >= maxMoments {
				break
			}
			is.moments = append(is.moments, r.pos)
		}
		out = append(out, is)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].cos != out[j].cos {
			return out[i].cos > out[j].cos
		}
		return out[i].item < out[j].item
	})
	return out
}
