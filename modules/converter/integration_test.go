//go:build integration

package converter

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

func mustTool(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s not on PATH", name)
	}
	return p
}

func gen(t *testing.T, ffmpeg, name string, args ...string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), name)
	full := append([]string{"-hide_banner", "-y"}, args...)
	full = append(full, out)
	if o, err := proc.Output(context.Background(), time.Minute, ffmpeg, full...); err != nil {
		t.Fatalf("generate %s: %v\n%s", name, err, o)
	}
	return out
}

func probe(t *testing.T, ffprobe, path, entries string) string {
	t.Helper()
	o, err := proc.Output(context.Background(), 15*time.Second, ffprobe,
		"-v", "error", "-show_entries", entries, "-of", "csv=p=0", path)
	if err != nil {
		t.Fatalf("ffprobe %s: %v\n%s", path, err, o)
	}
	return o
}

func runReal(t *testing.T, ffmpeg, ffprobe, input string, opts Options) []string {
	t.Helper()
	var r recorder
	job := r.job(t, input, opts)
	job = core.NewJobContext(*job, core.JobHooks{
		Progress: func(float64, string) {},
		Title:    func(string) {},
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) {
			if id == "ffmpeg" {
				return ffmpeg, nil
			}
			return ffprobe, nil
		},
	})
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatalf("%s: %v", opts.Preset, err)
	}
	return r.outputs
}

func TestIntegrationAllPresets(t *testing.T) {
	ffmpeg, ffprobe := mustTool(t, "ffmpeg"), mustTool(t, "ffprobe")
	inputs := map[core.OutputKind]string{
		core.KindAudio: gen(t, ffmpeg, "in.wav", "-f", "lavfi", "-i", "sine=d=3"),
		core.KindVideo: gen(t, ffmpeg, "in.mp4", "-f", "lavfi", "-i", "testsrc=s=320x240:d=2:r=15",
			"-f", "lavfi", "-i", "sine=d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"),
		core.KindImage: gen(t, ffmpeg, "in.png", "-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-frames:v", "1"),
	}
	encoders, _ := proc.Output(context.Background(), 15*time.Second, ffmpeg, "-hide_banner", "-encoders")
	for _, p := range presets {
		for _, kind := range p.Accepts {
			t.Run(string(p.ID)+"/"+string(kind), func(t *testing.T) {
				for _, enc := range []string{"libx265", "libvpx-vp9", "libopus", "libmp3lame", "libwebp"} {
					if strings.Contains(strings.Join(p.Args, " "), enc) && !strings.Contains(encoders, enc) {
						t.Skipf("ffmpeg lacks %s", enc)
					}
				}
				outs := runReal(t, ffmpeg, ffprobe, inputs[kind], Options{Preset: p.ID, MaxHeight: HeightKeep, KeepMetadata: true})
				if len(outs) != 1 || filepath.Ext(outs[0]) != p.Ext {
					t.Fatalf("outputs = %v", outs)
				}
				if fi, err := os.Stat(outs[0]); err != nil || fi.Size() == 0 {
					t.Fatalf("output: %v", err)
				}
				probe(t, ffprobe, outs[0], "format=format_name")
			})
		}
	}
}

func TestIntegrationScale(t *testing.T) {
	ffmpeg, ffprobe := mustTool(t, "ffmpeg"), mustTool(t, "ffprobe")
	in := gen(t, ffmpeg, "hd.mp4", "-f", "lavfi", "-i", "testsrc=s=1280x720:d=1:r=10",
		"-c:v", "libx264", "-pix_fmt", "yuv420p")
	outs := runReal(t, ffmpeg, ffprobe, in, Options{Preset: "mp4-h264", MaxHeight: Height480})
	h := strings.TrimSpace(probe(t, ffprobe, outs[0], "stream=height"))
	if n, _ := strconv.Atoi(h); n != 480 {
		t.Errorf("height = %q, want 480", h)
	}
	// A smaller source is never upscaled.
	small := gen(t, ffmpeg, "sd.mp4", "-f", "lavfi", "-i", "testsrc=s=320x240:d=1:r=10",
		"-c:v", "libx264", "-pix_fmt", "yuv420p")
	outs = runReal(t, ffmpeg, ffprobe, small, Options{Preset: "mp4-h264", MaxHeight: Height480})
	if h := strings.TrimSpace(probe(t, ffprobe, outs[0], "stream=height")); h != "240" {
		t.Errorf("height = %q, want 240", h)
	}
}
