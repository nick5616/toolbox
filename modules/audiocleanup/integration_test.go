//go:build integration

package audiocleanup

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

func mustTool(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s not on PATH", name)
	}
	return p
}

func ffgen(t *testing.T, ffmpeg, name string, args ...string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), name)
	full := append([]string{"-hide_banner", "-y"}, args...)
	full = append(full, out)
	if o, err := proc.Output(context.Background(), time.Minute, ffmpeg, full...); err != nil {
		t.Fatalf("generate %s: %v\n%s", name, err, o)
	}
	return out
}

// speechLike is a 220 Hz tone with syllable-rate tremolo, light pink noise
// and (optionally) mains hum, 44.1 kHz mono.
func speechSrc(hum int, secs int) []string {
	d := strconv.Itoa(secs)
	args := []string{
		"-f", "lavfi", "-i", "sine=f=220:r=44100:d=" + d,
		"-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.02:r=44100:d=" + d,
	}
	fc := "[0]tremolo=f=4:d=0.7,volume=0.2[s];[1]volume=1[n];"
	mix := "[s][n]"
	count := 2
	if hum > 0 {
		args = append(args, "-f", "lavfi", "-i", "sine=f="+strconv.Itoa(hum)+":r=44100:d="+d)
		fc += "[2]volume=0.03[h];"
		mix += "[h]"
		count = 3
	}
	fc += mix + "amix=inputs=" + strconv.Itoa(count) + ":normalize=0[a]"
	return append(args, "-filter_complex", fc, "-map", "[a]", "-ac", "1")
}

type recorder struct {
	outputs []string
	result  json.RawMessage
	calls   int
}

func (r *recorder) job(t *testing.T, ffmpeg, ffprobe, input string, o Options) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(o)
	return core.NewJobContext(core.JobContext{
		ID: "job42", Inputs: []string{input}, Options: raw, OutputDir: t.TempDir(), TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(float64, string) {},
		Log:      func(core.LogStream, string) {},
		Title:    func(string) {},
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) {
			switch id {
			case "ffmpeg":
				return ffmpeg, nil
			case "ffprobe":
				return ffprobe, nil
			}
			return "/engine", nil
		},
		Result: func(b json.RawMessage) { r.result = b },
	})
}

// identityEngine stands in for DeepFilterNet3: it copies the staged WAV.
type identityEngine struct{ calls int }

func (e *identityEngine) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	e.calls++
	p := params.(map[string]any)
	onEvent(sidecar.Event{Kind: "progress", Pct: 1, Msg: "Isolating voice"})
	in, err := os.Open(p["path"].(string))
	if err != nil {
		return nil, err
	}
	defer in.Close()
	out, err := os.Create(p["out"].(string))
	if err != nil {
		return nil, err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return json.RawMessage(`{}`), err
}

// loudnessOf returns integrated loudness and true peak (dBTP) of a file.
func loudnessOf(t *testing.T, ffmpeg, path string) (lufs, tp float64) {
	t.Helper()
	res, err := proc.Run(context.Background(), proc.Spec{Path: ffmpeg, Args: []string{
		"-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-",
	}})
	if err != nil {
		t.Fatal(err)
	}
	lufs, ok := parseEBU128(res.StderrTail)
	if !ok {
		t.Fatalf("no loudness in %v", res.StderrTail)
	}
	tp = -99
	for _, l := range res.StderrTail {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "Peak:") && strings.HasSuffix(l, "dBFS") {
			tp, _ = strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(l, "Peak:"), "dBFS")), 64)
		}
	}
	return lufs, tp
}

func duration(t *testing.T, ffprobe, path string) float64 {
	t.Helper()
	o, err := proc.Output(context.Background(), 15*time.Second, ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := strconv.ParseFloat(strings.TrimSpace(o), 64)
	return f
}

func runFile(t *testing.T, m *Module, rec *recorder, ffmpeg, ffprobe, input string, o Options) Result {
	t.Helper()
	if err := m.Run(context.Background(), rec.job(t, ffmpeg, ffprobe, input, o)); err != nil {
		t.Fatal(err)
	}
	var res Result
	if err := json.Unmarshal(rec.result, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func TestPodcastLoudnessAndHum(t *testing.T) {
	ffmpeg, ffprobe := mustTool(t, "ffmpeg"), mustTool(t, "ffprobe")
	for _, hum := range []int{50, 60} {
		t.Run(strconv.Itoa(hum), func(t *testing.T) {
			in := ffgen(t, ffmpeg, "talk.wav", speechSrc(hum, 40)...)
			o := DefaultOptions()
			o.Denoise = DenoiseLight
			var rec recorder
			res := runFile(t, &Module{}, &rec, ffmpeg, ffprobe, in, o)
			if len(res.Files) != 1 || len(rec.outputs) != 1 {
				t.Fatalf("result %+v outputs %v", res, rec.outputs)
			}
			f := res.Files[0]
			if f.HumHz != hum {
				t.Fatalf("hum %d, want %d", f.HumHz, hum)
			}
			if !strings.HasSuffix(f.Output, "talk (clean).wav") {
				t.Fatalf("output %q", f.Output)
			}
			lufs, tp := loudnessOf(t, ffmpeg, f.Output)
			if lufs < -17 || lufs > -15 {
				t.Errorf("loudness %.2f LUFS, want -16 +- 1", lufs)
			}
			if tp > -1.4 {
				t.Errorf("true peak %.2f dBTP, want <= -1.5", tp)
			}
			if f.LUFSBefore > -20 {
				t.Errorf("before %.1f looks wrong", f.LUFSBefore)
			}
			if f.LUFSAfter < -17 || f.LUFSAfter > -15 {
				t.Errorf("reported after %.2f", f.LUFSAfter)
			}
		})
	}
}

func TestNoHumOnCleanSignal(t *testing.T) {
	ffmpeg, ffprobe := mustTool(t, "ffmpeg"), mustTool(t, "ffprobe")
	in := ffgen(t, ffmpeg, "clean.wav", speechSrc(0, 35)...)
	o := DefaultOptions()
	o.Denoise = DenoiseOff
	o.Loudness = LoudnessOff
	var rec recorder
	res := runFile(t, &Module{}, &rec, ffmpeg, ffprobe, in, o)
	if res.Files[0].HumHz != 0 {
		t.Fatalf("hum %d", res.Files[0].HumHz)
	}
}

func TestStrongUsesEmbeddedModel(t *testing.T) {
	ffmpeg, ffprobe := mustTool(t, "ffmpeg"), mustTool(t, "ffprobe")
	in := ffgen(t, ffmpeg, "n.wav", speechSrc(50, 12)...)
	o := DefaultOptions()
	o.Denoise = DenoiseStrong
	o.Format = FormatFLAC
	var rec recorder
	res := runFile(t, &Module{}, &rec, ffmpeg, ffprobe, in, o)
	if !strings.HasSuffix(res.Files[0].Output, ".flac") {
		t.Fatal(res.Files[0].Output)
	}
}

func streamMD5(t *testing.T, ffmpeg, path string) string {
	t.Helper()
	o, err := proc.Output(context.Background(), time.Minute, ffmpeg, "-hide_banner", "-i", path, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-")
	if err != nil {
		t.Fatal(err, o)
	}
	i := strings.LastIndex(o, "MD5=")
	if i < 0 {
		t.Fatalf("no md5 in %q", o)
	}
	return strings.Fields(o[i:])[0]
}

func TestVideoKeepsVideoStream(t *testing.T) {
	ffmpeg, ffprobe := mustTool(t, "ffmpeg"), mustTool(t, "ffprobe")
	in := ffgen(t, ffmpeg, "clip.mp4",
		"-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:d=12",
		"-f", "lavfi", "-i", "sine=f=220:d=12",
		"-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest")
	for _, mode := range []Denoise{DenoiseLight, DenoiseVoice} {
		t.Run(string(mode), func(t *testing.T) {
			dir := t.TempDir()
			m := &Module{modelsDir: dir}
			if mode == DenoiseVoice {
				md := m.voiceModelDir()
				_ = os.MkdirAll(md, 0o755)
				for _, f := range dfn3Model.Files {
					_ = os.WriteFile(filepath.Join(md, f.Name), make([]byte, f.Bytes), 0o644)
				}
				m.sc = &identityEngine{}
			}
			o := DefaultOptions()
			o.Denoise = mode
			o.Format = FormatWAV // ignored for video
			var rec recorder
			res := runFile(t, m, &rec, ffmpeg, ffprobe, in, o)
			out := res.Files[0].Output
			if filepath.Ext(out) != ".mp4" {
				t.Fatalf("container changed: %s", out)
			}
			if a, b := streamMD5(t, ffmpeg, in), streamMD5(t, ffmpeg, out); a != b {
				t.Fatalf("video stream changed: %s vs %s", a, b)
			}
			if d := duration(t, ffprobe, out); d < 11.5 || d > 12.6 {
				t.Fatalf("duration %.2f", d)
			}
			if mode == DenoiseVoice && m.sc.(*identityEngine).calls != 1 {
				t.Fatal("engine not called once")
			}
		})
	}
}

func TestPreviewWritesBothExcerpts(t *testing.T) {
	ffmpeg, ffprobe := mustTool(t, "ffmpeg"), mustTool(t, "ffprobe")
	in := ffgen(t, ffmpeg, "talk.wav", speechSrc(50, 40)...)
	pd := t.TempDir()
	m := &Module{previewDir: pd}
	o := DefaultOptions()
	o.Denoise = DenoiseLight
	o.Preview = true
	o.PreviewStartMs = 12000
	var rec recorder
	res := runFile(t, m, &rec, ffmpeg, ffprobe, in, o)
	if len(rec.outputs) != 0 {
		t.Fatalf("preview registered outputs: %v", rec.outputs)
	}
	if filepath.Dir(res.PreviewOriginal) != pd || filepath.Base(res.PreviewOriginal) != "job42-a.wav" || filepath.Base(res.PreviewCleaned) != "job42-b.wav" {
		t.Fatalf("%+v", res)
	}
	da, db := duration(t, ffprobe, res.PreviewOriginal), duration(t, ffprobe, res.PreviewCleaned)
	if da < 9.9 || da > 10.1 || db < 9.9 || db > 10.1 {
		t.Fatalf("durations %.2f %.2f", da, db)
	}
	if res.HumHz != 50 || res.LUFSAfter > -15 || res.LUFSAfter < -17 {
		t.Fatalf("%+v", res)
	}
	m.prunePreviewsAll()
	if _, err := os.Stat(res.PreviewOriginal); !os.IsNotExist(err) {
		t.Fatal("preview not discarded")
	}
}
