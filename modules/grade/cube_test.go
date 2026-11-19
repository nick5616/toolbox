package grade

import (
	"bytes"
	"context"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func identityLattice(size int) []float64 {
	out := make([]float64, 0, size*size*size*3)
	for b := 0; b < size; b++ {
		for g := 0; g < size; g++ {
			for r := 0; r < size; r++ { // red fastest
				out = append(out, float64(r)/float64(size-1), float64(g)/float64(size-1), float64(b)/float64(size-1))
			}
		}
	}
	return out
}

func TestWriteCubeFormat(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteCube(&buf, `My "Look"`, 2, identityLattice(2)); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 4+8 {
		t.Fatalf("%d lines:\n%s", len(lines), buf.String())
	}
	for i, want := range []string{`TITLE "My Look"`, "LUT_3D_SIZE 2", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"} {
		if lines[i] != want {
			t.Errorf("line %d = %q, want %q", i, lines[i], want)
		}
	}
	// Red varies fastest: the second data line is (1, 0, 0), the third (0, 1, 0).
	if lines[4] != "0.000000 0.000000 0.000000" || lines[5] != "1.000000 0.000000 0.000000" || lines[6] != "0.000000 1.000000 0.000000" || lines[11] != "1.000000 1.000000 1.000000" {
		t.Errorf("data:\n%s", strings.Join(lines[4:], "\n"))
	}
}

func TestWriteCubeValidation(t *testing.T) {
	ok := identityLattice(2)
	for name, tc := range map[string]struct {
		size int
		data []float64
	}{
		"size 1":       {1, ok},
		"size 66":      {66, ok},
		"short":        {2, ok[:23]},
		"long":         {2, append(append([]float64{}, ok...), 0)},
		"33 with 2":    {33, ok},
		"not a number": {2, append([]float64{math.NaN()}, ok[1:]...)},
	} {
		err := WriteCube(&bytes.Buffer{}, "x", tc.size, tc.data)
		if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeValidation {
			t.Errorf("%s: %v", name, err)
		}
	}
	var buf bytes.Buffer
	data := make([]float64, 24)
	data[0], data[1], data[2] = -1, 2, 0.5
	if err := WriteCube(&buf, "x", 2, data); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "0.000000 1.000000 0.500000") {
		t.Errorf("values aren't clamped:\n%s", buf.String())
	}
	if err := WriteCube(&bytes.Buffer{}, "x", 33, identityLattice(33)); err != nil {
		t.Errorf("33^3: %v", err)
	}
}

type fakeOutputs struct{ got []core.Output }

func (f *fakeOutputs) UpsertOutput(_ context.Context, o core.Output) (core.Output, error) {
	f.got = append(f.got, o)
	return o, nil
}
func (f *fakeOutputs) GetOutput(context.Context, string) (core.Output, error) {
	return core.Output{}, nil
}
func (f *fakeOutputs) ListOutputs(context.Context, core.OutputQuery) (core.OutputPage, error) {
	return core.OutputPage{}, nil
}
func (f *fakeOutputs) DeleteOutput(context.Context, string) error { return nil }
func (f *fakeOutputs) MoveOutput(context.Context, string, string) (core.Output, error) {
	return core.Output{}, nil
}

func TestSaveCubeWritesUniqueFilesAndRegistersThem(t *testing.T) {
	m := newModule(t, nil, nil)
	outs := &fakeOutputs{}
	m.cfg.Outputs = outs
	data := identityLattice(3)
	p1, err := m.SaveCube(context.Background(), `Neon: Noir/?`, 3, data)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := m.SaveCube(context.Background(), `Neon: Noir/?`, 3, data)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(m.cfg.LibraryDir(), "Graded", "LUTs")
	if filepath.Dir(p1) != want || p1 == p2 || !strings.HasSuffix(p1, ".cube") {
		t.Errorf("paths %q, %q", p1, p2)
	}
	if strings.ContainsAny(filepath.Base(p1), `:/?`) {
		t.Errorf("unsafe file name %q", p1)
	}
	b, err := os.ReadFile(p1)
	if err != nil || !strings.Contains(string(b), "LUT_3D_SIZE 3") {
		t.Errorf("file: %v\n%s", err, b)
	}
	if len(outs.got) != 2 || outs.got[0].ModuleID != ModuleID || outs.got[0].Path != p1 || outs.got[0].SizeBytes == 0 {
		t.Errorf("outputs = %+v", outs.got)
	}
	if _, err := m.SaveCube(context.Background(), "x", 3, data[:5]); err == nil {
		t.Error("a short lattice was written")
	}
	entries, _ := os.ReadDir(want)
	if len(entries) != 2 {
		t.Errorf("%d files, want 2 (a failed save leaves none)", len(entries))
	}
}
