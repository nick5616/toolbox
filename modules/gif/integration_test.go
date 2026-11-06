//go:build integration

package gif

import (
	"bytes"
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

func makeClip(t *testing.T, ffmpeg string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "clip.mp4")
	cmd := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make clip: %v\n%s", err, b)
	}
	return out
}

func runReal(t *testing.T, input string, o Options) (Result, error) {
	t.Helper()
	ffmpeg, ffprobe := ffTools(t)
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
	err := (&Module{}).Run(context.Background(), job)
	return res, err
}

func head(t *testing.T, path string, n int) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b[:min(n, len(b))]
}

func TestRealGIF(t *testing.T) {
	ffmpeg, _ := ffTools(t)
	in := makeClip(t, ffmpeg)
	o := DefaultOptions()
	o.StartSec, o.LengthSec, o.FPS, o.Width = 1, 2, 10, 320
	res, err := runReal(t, in, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Outputs) != 1 || filepath.Ext(res.Outputs[0]) != ".gif" || res.SizeBytes == 0 {
		t.Fatalf("result = %+v", res)
	}
	if !bytes.HasPrefix(head(t, res.Outputs[0], 6), []byte("GIF89a")) {
		t.Error("not a GIF")
	}
}

func TestRealWebP(t *testing.T) {
	ffmpeg, _ := ffTools(t)
	in := makeClip(t, ffmpeg)
	o := DefaultOptions()
	o.Mode, o.LengthSec, o.FPS, o.Width = ModeWebP, 2, 10, 320
	res, err := runReal(t, in, o)
	if err != nil {
		t.Fatal(err)
	}
	b := head(t, res.Outputs[0], 12)
	if !bytes.HasPrefix(b, []byte("RIFF")) || !bytes.Equal(b[8:12], []byte("WEBP")) {
		t.Errorf("not a WebP: %q", b)
	}
}

func TestRealSheet(t *testing.T) {
	ffmpeg, _ := ffTools(t)
	in := makeClip(t, ffmpeg)
	for _, labels := range []bool{true, false} {
		o := DefaultOptions()
		o.Mode, o.Columns, o.Rows, o.CellWidth, o.Labels = ModeSheet, 3, 2, 240, labels
		res, err := runReal(t, in, o)
		if err != nil {
			t.Fatalf("labels=%v: %v", labels, err)
		}
		if res.Frames != 6 || filepath.Ext(res.Outputs[0]) != ".jpg" || res.SizeBytes < 2000 {
			t.Fatalf("labels=%v: result = %+v", labels, res)
		}
		if b := head(t, res.Outputs[0], 3); !bytes.Equal(b, []byte{0xFF, 0xD8, 0xFF}) {
			t.Errorf("not a JPEG: %x", b)
		}
	}
}

func TestRealStartTooLate(t *testing.T) {
	ffmpeg, _ := ffTools(t)
	in := makeClip(t, ffmpeg)
	o := DefaultOptions()
	o.StartSec = 11.9
	if _, err := runReal(t, in, o); err == nil {
		t.Fatal("a start at the very end was accepted")
	}
}
