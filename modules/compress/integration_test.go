//go:build integration

package compress

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

const (
	defaultFFDir    = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\win\ffmpeg-9.0.2-essentials_build\bin`
	defaultProbeDir = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\smoke\bin\ffmpeg`
)

// ffTools finds ffmpeg and ffprobe (TOOLBOX_TEST_FFMPEG_DIR, the research
// download, then PATH), skipping the test when they are missing.
func ffTools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	dirs := []string{defaultFFDir, defaultProbeDir}
	if d := os.Getenv("TOOLBOX_TEST_FFMPEG_DIR"); d != "" {
		dirs = append([]string{d}, dirs...)
	}
	find := func(name string) string {
		for _, d := range dirs {
			p := filepath.Join(d, name+".exe")
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
		if lp, err := exec.LookPath(name); err == nil {
			return lp
		}
		t.Skipf("%s not found", name)
		return ""
	}
	return find("ffmpeg"), find("ffprobe")
}

func makeVideo(t *testing.T, ffmpeg string, seconds int, withAudio bool) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "source.mp4")
	args := []string{"-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=" + itoa(seconds)}
	if withAudio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration="+itoa(seconds))
	}
	args = append(args, "-c:v", "libx264", "-b:v", "12M", "-pix_fmt", "yuv420p")
	if withAudio {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	}
	args = append(args, out)
	if b, err := exec.Command(ffmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("make video: %v\n%s", err, b)
	}
	return out
}

func makeAudio(t *testing.T, ffmpeg string, seconds int) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "source.wav")
	args := []string{"-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=" + itoa(seconds), "-ac", "2", out}
	if b, err := exec.Command(ffmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("make audio: %v\n%s", err, b)
	}
	return out
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// runModule runs Module.Run end to end and returns its Result.
func runModule(t *testing.T, ffmpeg, ffprobe, src string, o Options) (Result, error) {
	t.Helper()
	raw, _ := json.Marshal(o)
	var result json.RawMessage
	job := core.NewJobContext(core.JobContext{
		ID: "job1", ModuleID: ModuleID, Inputs: []string{src}, Options: raw, OutputDir: t.TempDir(), TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(float64, string) {},
		Log:      func(core.LogStream, string) {},
		Title:    func(string) {},
		Output:   func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
		Tool: func(id string) (string, error) {
			switch id {
			case "ffmpeg":
				return ffmpeg, nil
			case "ffprobe":
				return ffprobe, nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
		Result: func(b json.RawMessage) { result = b },
	})
	err := (&Module{}).Run(context.Background(), job)
	var res Result
	if result != nil {
		if e := json.Unmarshal(result, &res); e != nil {
			t.Fatal(e)
		}
	}
	return res, err
}

func customOpts(mb float64, mod func(*Options)) Options {
	o := DefaultOptions()
	o.TargetID, o.TargetMB = CustomTarget, mb
	if mod != nil {
		mod(&o)
	}
	return o
}

func TestIntegrationVideoTo2MB(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	src := makeVideo(t, ffmpeg, 20, true)
	res, err := runModule(t, ffmpeg, ffprobe, src, customOpts(2, nil))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Fits || len(res.Outputs) != 1 {
		t.Fatalf("result %+v", res)
	}
	t.Logf("20 s 1080p -> %d bytes (limit 2000000), %s, grade %s, %d attempts", res.FinalBytes, res.Plan, res.Grade, res.Attempts)
	if res.FinalBytes > 2_000_000 || filepath.Ext(res.Outputs[0]) != ".mp4" {
		t.Errorf("output %s is %d bytes", res.Outputs[0], res.FinalBytes)
	}
	info, err := media.Probe(context.Background(), ffprobe, res.Outputs[0])
	if err != nil {
		t.Fatal(err)
	}
	if info.Video == nil || info.Video.Codec != "h264" || len(info.Audio) == 0 || info.Audio[0].Codec != "aac" {
		t.Errorf("probe: %+v", info)
	}
	if info.DurationMs < 19_000 || info.DurationMs > 21_000 {
		t.Errorf("duration %d ms", info.DurationMs)
	}
	// The estimate says what the run did.
	est := estimateVideo(context.Background(), func(id string) (string, error) { return ffprobe, nil },
		input{Path: src, Limit: 2_000_000, Opts: customOpts(2, nil)})
	if !est.Possible || est.Plan != res.Plan {
		t.Errorf("estimate %+v vs run plan %q", est, res.Plan)
	}
}

func TestIntegrationVideoH265(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	src := makeVideo(t, ffmpeg, 10, true)
	res, err := runModule(t, ffmpeg, ffprobe, src, customOpts(1, func(o *Options) { o.VideoCodec = CodecH265 }))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("10 s H.265 -> %d bytes (limit 1000000), %s", res.FinalBytes, res.Plan)
	info, err := media.Probe(context.Background(), ffprobe, res.Outputs[0])
	if err != nil || info.Video == nil || info.Video.Codec != "hevc" {
		t.Errorf("probe: %+v %v", info, err)
	}
	if !res.Fits {
		t.Errorf("does not fit: %+v", res)
	}
}

func TestIntegrationVideoSplit(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	src := makeVideo(t, ffmpeg, 60, true)
	res, err := runModule(t, ffmpeg, ffprobe, src, customOpts(0.5, func(o *Options) { o.IfTooSmall = TooSmallSplit }))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("60 s -> %d parts, largest %d bytes, total %d, %s", len(res.Outputs), res.FinalBytes, res.TotalBytes, res.Plan)
	if len(res.Outputs) < 2 || !res.Fits {
		t.Fatalf("result %+v", res)
	}
	var total int64
	for _, o := range res.Outputs {
		n, _ := fileSize(o)
		if n > 500_000 {
			t.Errorf("%s is %d bytes", o, n)
		}
		info, err := media.Probe(context.Background(), ffprobe, o)
		if err != nil || info.Video == nil {
			t.Errorf("part %s: %v", o, err)
			continue
		}
		total += info.DurationMs
	}
	if total < 58_000 || total > 62_000 {
		t.Errorf("parts add up to %d ms", total)
	}
}

func TestIntegrationAudioTo300KB(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	src := makeAudio(t, ffmpeg, 60)
	res, err := runModule(t, ffmpeg, ffprobe, src, customOpts(0.3, nil))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("60 s wav -> %d bytes (limit 300000), %s, grade %s", res.FinalBytes, res.Plan, res.Grade)
	if !res.Fits || filepath.Ext(res.Outputs[0]) != ".mp3" {
		t.Errorf("result %+v", res)
	}
	info, err := media.Probe(context.Background(), ffprobe, res.Outputs[0])
	if err != nil || len(info.Audio) == 0 || info.Audio[0].Codec != "mp3" {
		t.Errorf("probe: %+v %v", info, err)
	}
}

func TestIntegrationAudioOpus(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	src := makeAudio(t, ffmpeg, 300)
	res, err := runModule(t, ffmpeg, ffprobe, src, customOpts(0.1, nil)) // ~2.6 kb/s... too small for 6k? 100 KB over 300 s = 2.6 kb/s
	if err == nil {
		t.Fatalf("expected an impossible error, got %+v", res)
	}
	res, err = runModule(t, ffmpeg, ffprobe, src, customOpts(0.15, nil)) // ~3.9 kb/s still under 6
	if err == nil {
		t.Fatalf("expected an impossible error, got %+v", res)
	}
	res, err = runModule(t, ffmpeg, ffprobe, src, customOpts(0.3, nil)) // ~7.7 kb/s: Opus
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("300 s -> %d bytes (limit 300000), %s", res.FinalBytes, res.Plan)
	if filepath.Ext(res.Outputs[0]) != ".ogg" || !res.Fits {
		t.Errorf("result %+v", res)
	}
}

func TestIntegrationNoSound(t *testing.T) {
	ffmpeg, ffprobe := ffTools(t)
	src := makeVideo(t, ffmpeg, 5, false)
	est := estimateAudio(context.Background(), func(id string) (string, error) { return ffprobe, nil },
		input{Path: src, Limit: 1000, Opts: customOpts(0.05, nil)})
	if est.Problem != "This file has no sound" {
		t.Errorf("estimate %+v", est)
	}
}
