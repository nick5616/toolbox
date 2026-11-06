//go:build integration

package silence

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
)

const defaultFFDir = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\smoke\bin\ffmpeg`

func ffTools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	dir := os.Getenv("TOOLBOX_TEST_FFMPEG_DIR")
	if dir == "" {
		dir = defaultFFDir
	}
	ffmpeg, ffprobe = filepath.Join(dir, "ffmpeg.exe"), filepath.Join(dir, "ffprobe.exe")
	for _, p := range []string{ffmpeg, ffprobe} {
		if _, err := os.Stat(p); err != nil {
			if lp, e := exec.LookPath(filepath.Base(p)); e == nil {
				if filepath.Base(p) == "ffmpeg.exe" {
					ffmpeg = lp
				} else {
					ffprobe = lp
				}
				continue
			}
			t.Skipf("FFmpeg not found at %s", p)
		}
	}
	return ffmpeg, ffprobe
}

// speech makes 2 s tone, 3 s silence, 2 s tone, 3 s silence (10 s).
func speech(t *testing.T, ffmpeg, name string, video bool) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), name)
	args := []string{"-v", "error", "-y"}
	graph := "sine=frequency=440:duration=2,aformat=sample_rates=44100:channel_layouts=mono[t1];" +
		"anullsrc=r=44100:cl=mono,atrim=duration=3[s1];" +
		"sine=frequency=660:duration=2,aformat=sample_rates=44100:channel_layouts=mono[t2];" +
		"anullsrc=r=44100:cl=mono,atrim=duration=3[s2];" +
		"[t1][s1][t2][s2]concat=n=4:v=0:a=1[a]"
	args = append(args, "-filter_complex", graph)
	if video {
		args = append(args, "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=10",
			"-map", "[a]", "-map", "0:v", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
	} else {
		args = append(args, "-map", "[a]", "-c:a", "pcm_s16le")
	}
	args = append(args, out)
	if b, err := exec.Command(ffmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("make input: %v\n%s", err, b)
	}
	return out
}

func runReal(t *testing.T, ffmpeg, ffprobe, input string, o Options) (Result, string) {
	t.Helper()
	m := &Module{}
	raw, _ := json.Marshal(o)
	var res Result
	outDir := filepath.Join(t.TempDir(), "out")
	tool := func(id string) (string, error) {
		if id == "ffmpeg" {
			return ffmpeg, nil
		}
		return ffprobe, nil
	}
	job := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: outDir, TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
		Result: func(b json.RawMessage) { _ = json.Unmarshal(b, &res) },
		Tool:   tool,
	})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}
	return res, outDir
}

func TestRunAudio(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	in := speech(t, ffmpeg, "talk.wav", false)
	res, _ := runReal(t, ffmpeg, ffprobe, in, DefaultOptions())
	info, err := media.Probe(context.Background(), ffprobe, res.Output)
	if err != nil {
		t.Fatal(err)
	}
	// 4 s of tone plus the padding kept around two cuts (the last silence runs to the end).
	if d := info.DurationMs; d < 4200 || d > 5200 {
		t.Fatalf("duration %d ms; result %+v", d, res)
	}
	if res.RemovedMs < 4500 || res.CutList == "" {
		t.Fatalf("%+v", res)
	}
	if b, err := os.ReadFile(res.CutList); err != nil || len(b) < 30 {
		t.Fatalf("cut list: %v %q", err, b)
	}
}

func TestRunVideo(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	in := speech(t, ffmpeg, "talk.mp4", true)
	o := DefaultOptions()
	o.CutList = false
	res, _ := runReal(t, ffmpeg, ffprobe, in, o)
	info, err := media.Probe(context.Background(), ffprobe, res.Output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Video == nil || len(info.Audio) == 0 {
		t.Fatalf("streams lost: %+v", info)
	}
	if d := info.DurationMs; d < 4200 || d > 5400 {
		t.Fatalf("duration %d ms; result %+v", d, res)
	}
	if res.CutList != "" {
		t.Fatal("cut list written when off")
	}
}

func TestNothingSilent(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	in := filepath.Join(t.TempDir(), "tone.wav")
	if b, err := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", in).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, b)
	}
	m := &Module{}
	raw, _ := json.Marshal(DefaultOptions())
	job := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{in}, Options: raw,
		OutputDir: t.TempDir(), TempDir: t.TempDir(),
	}, core.JobHooks{
		Tool: func(id string) (string, error) {
			if id == "ffmpeg" {
				return ffmpeg, nil
			}
			return ffprobe, nil
		},
	})
	err := m.Run(context.Background(), job)
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeValidation {
		t.Fatalf("got %v", err)
	}
}
