package imagebatch

import (
	"context"
	"encoding/json"
	"image/color"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"toolbox/core"
)

// A parallel batch must name, register and report exactly like a sequential
// one: input order, UniquePath suffixes for clashing stems, monotonic progress.
func TestRunParallelKeepsOrderAndNames(t *testing.T) {
	dir := t.TempDir()
	var inputs []string
	for d := 0; d < 3; d++ { // same stems in three folders, so names clash
		sub := filepath.Join(dir, string(rune('a'+d)))
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 8; i++ {
			p := filepath.Join(sub, "pic"+string(rune('0'+i))+".png")
			writePNG(t, p, 20+i*3, 10+d, color.NRGBA{uint8(i * 20), 10, 10, 255})
			inputs = append(inputs, p)
		}
	}
	opts := DefaultOptions()
	opts.Name = "{name}"
	raw, _ := json.Marshal(opts)
	out := t.TempDir()

	var mu sync.Mutex
	var registered []string
	var progress []float64
	job := core.NewJobContext(core.JobContext{Inputs: inputs, Options: raw, OutputDir: out, TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(p float64, _ string) { mu.Lock(); progress = append(progress, p); mu.Unlock() },
		Output: func(p string) (core.Output, error) {
			mu.Lock()
			registered = append(registered, filepath.Base(p))
			mu.Unlock()
			return core.Output{Path: p}, nil
		},
		Tool: func(string) (string, error) { return "", core.ErrDependencyMissing("ffmpeg", "no") },
	})
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(registered) != len(inputs) {
		t.Fatalf("registered %d of %d", len(registered), len(inputs))
	}
	seq := t.TempDir()
	for i, in := range inputs {
		want := filepath.Base(core.UniquePath(seq, core.StemName(in), ".jpg"))
		if err := os.WriteFile(filepath.Join(seq, want), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if registered[i] != want {
			t.Fatalf("output %d is %s, a sequential run gives %s", i, registered[i], want)
		}
	}
	for i := 1; i < len(progress); i++ {
		if progress[i] < progress[i-1] {
			t.Fatalf("progress went back: %v", progress)
		}
	}
}
