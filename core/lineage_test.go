package core

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func TestLineageInputs(t *testing.T) {
	a, b := `C:\x\photo.jpg`, `C:\x\other.png`
	tests := []struct {
		name     string
		out      string
		explicit []string
		in       []string
		want     []string
	}{
		{"explicit wins", "o/photo.png", []string{b}, []string{a}, []string{b}},
		{"explicit empty", "o/photo.png", []string{}, []string{a}, []string{}},
		{"single", "o/anything.png", nil, []string{a}, []string{a}},
		{"none", "o/anything.png", nil, nil, nil},
		{"prefix", "o/Photo_erased.png", nil, []string{a, b}, []string{a}},
		{"prefix case-insens", "o/PHOTO-2.png", nil, []string{b, a}, []string{a}},
		{"no match -> all", "o/zzz.png", nil, []string{a, b}, []string{a, b}},
		{"both match", "o/photo-other.png", nil, []string{a, `C:\y\photo.png`}, []string{a, `C:\y\photo.png`}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := LineageInputs(tc.out, tc.explicit, tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

type recLineage struct {
	mu   sync.Mutex
	rows map[string][]string
}

func (r *recLineage) AddOutputInputs(_ context.Context, id string, in []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rows[id] = append(r.rows[id], in...)
	return nil
}
func (r *recLineage) OutputInputs(context.Context, string) ([]string, error)     { return nil, nil }
func (r *recLineage) OutputsFromInput(context.Context, string) ([]Output, error) { return nil, nil }
func (r *recLineage) BackfillLineage(context.Context) (int, error)               { return 0, nil }

func TestJobOutputsRecordLineage(t *testing.T) {
	var a, b Output
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		p1 := filepath.Join(jc.OutputDir, "one.mp3")
		p2 := filepath.Join(jc.OutputDir, "two.mp3")
		must(t, os.WriteFile(p1, []byte("1"), 0o644))
		must(t, os.WriteFile(p2, []byte("2"), 0o644))
		var err error
		if a, err = jc.Output(p1); err != nil { // default rule
			return err
		}
		b, err = jc.OutputFrom(p2, "/x/y.wav", "/x/z.wav")
		return err
	})
	e := setup(t, 1, m)
	rec := &recLineage{rows: map[string][]string{}}
	e.m.SetLineage(rec)
	e.start(t)
	j := e.submit(t, "a", "/in/one-source.wav", "/in/other.wav")[0]
	e.em.waitStatus(t, j.ID, JobDone)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if got := rec.rows[a.ID]; len(got) != 2 {
		t.Fatalf("default rule (no stem match -> all): %v", got)
	}
	if got := rec.rows[b.ID]; !reflect.DeepEqual(got, []string{"/x/y.wav", "/x/z.wav"}) {
		t.Fatalf("explicit: %v", got)
	}
}
