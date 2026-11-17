//go:build integration

package scenes

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

// TestRealSplitOutputOrder: with clips and stills exported in parallel the
// registered outputs still come in scene order, clip then still.
func TestRealSplitOutputOrder(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	input := makeScenes(t, ffmpeg)
	raw, _ := json.Marshal(DefaultOptions())
	var registered []string
	var lastPct float64 = -1
	job := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) {
			registered = append(registered, p)
			return core.Output{Path: p}, nil
		},
		Progress: func(pct float64, _ string) {
			if pct >= 0 && pct < lastPct-1e-9 {
				t.Errorf("progress went back from %v to %v", lastPct, pct)
			}
			if pct >= 0 {
				lastPct = pct
			}
		},
		Tool: func(id string) (string, error) {
			if id == "ffmpeg" {
				return ffmpeg, nil
			}
			return ffprobe, nil
		},
	})
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(registered) != 6 {
		t.Fatalf("registered %v", registered)
	}
	for i, p := range registered {
		wantStill := i%2 == 1
		isStill := strings.HasSuffix(p, ".jpg")
		if isStill != wantStill {
			t.Errorf("output %d = %s", i, filepath.Base(p))
		}
		want := sceneName(core.StemName(input), i/2+1)
		if !strings.HasPrefix(filepath.Base(p), want) {
			t.Errorf("output %d = %s, want a file of %q", i, filepath.Base(p), want)
		}
	}
}
