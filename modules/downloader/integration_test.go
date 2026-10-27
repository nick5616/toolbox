//go:build integration

package downloader

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"toolbox/core"
)

// Runs real yt-dlp (and ffmpeg/ffprobe) from PATH. Network required.
func TestIntegrationRealYtDlp(t *testing.T) {
	tools := map[string]string{}
	for _, n := range []string{"yt-dlp", "ffmpeg", "ffprobe"} {
		p, err := exec.LookPath(n)
		if err != nil {
			t.Skipf("%s not on PATH", n)
		}
		tools[n] = p
	}
	opts := DefaultOptions()
	opts.TrimEnabled, opts.TrimStart, opts.TrimEnd = true, "0:02", "0:08"
	raw, _ := json.Marshal(opts)
	var outputs []string
	job := core.NewJobContext(core.JobContext{
		Inputs: []string{"https://www.youtube.com/watch?v=jNQXAC9IVRw"}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Log: func(s core.LogStream, l string) { t.Logf("%s: %s", s, l) },
		Output: func(p string) (core.Output, error) {
			outputs = append(outputs, p)
			_, err := os.Stat(p)
			return core.Output{Path: p}, err
		},
		Tool: func(id string) (string, error) {
			if p, ok := tools[id]; ok {
				return p, nil
			}
			if p, err := exec.LookPath(id); err == nil {
				return p, nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := (&Module{cacheDir: t.TempDir()}).Run(ctx, job); err != nil {
		t.Fatal(err)
	}
	if len(outputs) != 1 {
		t.Fatalf("outputs = %v", outputs)
	}
}
