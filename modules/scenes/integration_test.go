//go:build integration

package scenes

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"toolbox/core"
)

const defaultFFDir = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\smoke\bin\ffmpeg`

func ffTools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	if dir := os.Getenv("TOOLBOX_TEST_FFMPEG_DIR"); dir != "" {
		return filepath.Join(dir, "ffmpeg.exe"), filepath.Join(dir, "ffprobe.exe")
	}
	ffmpeg, e1 := exec.LookPath("ffmpeg")
	ffprobe, e2 := exec.LookPath("ffprobe")
	if e1 != nil || e2 != nil {
		ffmpeg, ffprobe = filepath.Join(defaultFFDir, "ffmpeg.exe"), filepath.Join(defaultFFDir, "ffprobe.exe")
		for _, p := range []string{ffmpeg, ffprobe} {
			if _, err := os.Stat(p); err != nil {
				t.Skipf("FFmpeg not found at %s", p)
			}
		}
	}
	return ffmpeg, ffprobe
}

// makeScenes renders 9 s of three flat/test scenes (cuts at 3 s and 6 s) with
// a 2 s GOP and no automatic keyframes, so the cut at 3 s is off a keyframe
// and the one at 6 s is on one.
func makeScenes(t *testing.T, ffmpeg string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "three.mp4")
	graph := "color=c=red:s=320x240:r=30:d=3[a];color=c=blue:s=320x240:r=30:d=3[b];testsrc2=s=320x240:r=30:d=3[c];[a][b][c]concat=n=3:v=1:a=0[v]"
	cmd := exec.Command(ffmpeg, "-v", "error", "-y", "-filter_complex", graph, "-map", "[v]",
		"-c:v", "libx264", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-pix_fmt", "yuv420p", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make clip: %v\n%s", err, b)
	}
	return out
}

func TestRealSplit(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	input := makeScenes(t, ffmpeg)
	m := &Module{}
	o := DefaultOptions()
	raw, _ := json.Marshal(o)
	if err := m.Validate([]string{input}, raw); err != nil {
		t.Fatal(err)
	}
	var res Result
	job := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
		Result: func(b json.RawMessage) { _ = json.Unmarshal(b, &res) },
		Tool: func(id string) (string, error) {
			if id == "ffmpeg" {
				return ffmpeg, nil
			}
			return ffprobe, nil
		},
	})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Found != 3 || len(res.Scenes) != 3 {
		t.Fatalf("found %d scenes, kept %d: %+v", res.Found, len(res.Scenes), res.Scenes)
	}
	for i, want := range []int64{3000, 6000} {
		if d := res.Scenes[i].EndMs - want; d < -100 || d > 100 {
			t.Errorf("scene %d ends at %d, want ~%d", i+1, res.Scenes[i].EndMs, want)
		}
	}
	if len(res.Outputs) != 6 {
		t.Fatalf("outputs = %v", res.Outputs)
	}
	for _, p := range res.Outputs {
		if st, err := os.Stat(p); err != nil || st.Size() == 0 {
			t.Errorf("%s: %v", p, err)
		}
	}
	if res.Reencoded != 1 {
		t.Errorf("re-encoded %d clips, want 1 (the scene starting off a keyframe)", res.Reencoded)
	}
}

func TestRealKeepLongestStillsOnly(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	input := makeScenes(t, ffmpeg)
	o := DefaultOptions()
	o.Output, o.Keep, o.KeepN = OutputStills, KeepLongest, 2
	raw, _ := json.Marshal(o)
	var res Result
	job := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
		Result: func(b json.RawMessage) { _ = json.Unmarshal(b, &res) },
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
	if len(res.Scenes) != 2 || len(res.Outputs) != 2 || res.Found != 3 {
		t.Fatalf("result = %+v", res)
	}
}
