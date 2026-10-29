//go:build integration

package lyricvideo

import (
	"context"
	"encoding/json"
	"fmt"
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

func tool(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s not on PATH", name)
	}
	return p
}

func ff(t *testing.T, ffmpeg string, args ...string) {
	t.Helper()
	full := append([]string{"-hide_banner", "-y", "-loglevel", "error"}, args...)
	if o, err := proc.Output(context.Background(), time.Minute, ffmpeg, full...); err != nil {
		t.Fatalf("ffmpeg %v: %v\n%s", args, err, o)
	}
}

func probeVal(t *testing.T, ffprobe, path string, args ...string) string {
	t.Helper()
	full := append([]string{"-v", "error"}, args...)
	full = append(full, "-of", "csv=p=0", path)
	o, err := proc.Output(context.Background(), 15*time.Second, ffprobe, full...)
	if err != nil {
		t.Fatalf("ffprobe %s: %v\n%s", path, err, o)
	}
	return strings.TrimSpace(o)
}

// countHighlight returns how many pixels of the frame at t are close to rgb.
func countHighlight(t *testing.T, ffmpeg, video string, at float64, r, g, b int) int {
	t.Helper()
	out := filepath.Join(t.TempDir(), "f.rgb")
	ff(t, ffmpeg, "-ss", fmt.Sprintf("%.2f", at), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out)
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	abs := func(v int) int {
		if v < 0 {
			return -v
		}
		return v
	}
	n := 0
	for i := 0; i+2 < len(data); i += 3 {
		if abs(int(data[i])-r) < 28 && abs(int(data[i+1])-g) < 28 && abs(int(data[i+2])-b) < 28 {
			n++
		}
	}
	return n
}

type fixture struct {
	ffmpeg, ffprobe string
	song            string // 6 s sine wave with a cover
	plain           string // 6 s sine wave without a cover
	cover           string
	video           string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	f := fixture{ffmpeg: tool(t, "ffmpeg"), ffprobe: tool(t, "ffprobe")}
	dir := t.TempDir()
	f.cover = filepath.Join(dir, "cover.png")
	ff(t, f.ffmpeg, "-f", "lavfi", "-i", "testsrc2=s=500x500:d=1", "-frames:v", "1", f.cover)
	f.song = filepath.Join(dir, "Song One.mp3")
	ff(t, f.ffmpeg, "-f", "lavfi", "-i", "sine=f=330:d=6", "-i", f.cover, "-map", "0:a", "-map", "1:v",
		"-c:a", "libmp3lame", "-c:v", "mjpeg", "-id3v2_version", "3", "-disposition:v", "attached_pic", f.song)
	f.plain = filepath.Join(dir, "Plain.flac")
	ff(t, f.ffmpeg, "-f", "lavfi", "-i", "sine=f=330:d=6", f.plain)
	f.video = filepath.Join(dir, "bg.mp4")
	ff(t, f.ffmpeg, "-f", "lavfi", "-i", "testsrc=s=320x240:d=1:r=10", "-pix_fmt", "yuv420p", f.video)
	return f
}

func (f fixture) run(t *testing.T, song string, o Options) (Result, []string) {
	t.Helper()
	m := &Module{cacheDir: filepath.Join(t.TempDir(), "cache")}
	raw, _ := json.Marshal(o)
	var outs []string
	var result json.RawMessage
	var logs []string
	job := core.NewJobContext(core.JobContext{
		ID: "job1", Inputs: []string{song}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { outs = append(outs, p); return core.Output{Path: p}, nil },
		Tool: func(id string) (string, error) {
			switch id {
			case "ffmpeg":
				return f.ffmpeg, nil
			case "ffprobe":
				return f.ffprobe, nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
		Result: func(r json.RawMessage) { result = r },
		Log:    func(_ core.LogStream, l string) { logs = append(logs, l) },
	})
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v\nlogs: %v", err, logs)
	}
	var res Result
	if err := json.Unmarshal(result, &res); err != nil {
		t.Fatal(err)
	}
	return res, outs
}

func testLines() []LyricLine {
	l := LyricLine{StartMs: 500, EndMs: 4500, Text: "Hello karaoke world", Words: []LyricWord{
		{StartMs: 500, EndMs: 1500, Text: "Hello"}, {StartMs: 1500, EndMs: 3000, Text: "karaoke"}, {StartMs: 3000, EndMs: 4500, Text: "world"},
	}}
	return []LyricLine{l, {StartMs: 4600, EndMs: 5800, Text: "Second line", Words: []LyricWord{}}}
}

func TestRenderMatrix(t *testing.T) {
	f := newFixture(t)
	for _, bg := range []string{"blur-cover", "cover", "color", "gradient", "image", "video"} {
		for _, aspect := range []string{"16:9", "9:16", "1:1"} {
			if aspect != "16:9" && bg != "cover" && bg != "gradient" {
				continue // keep the matrix quick: odd aspects on the layout-heavy backgrounds
			}
			t.Run(bg+"/"+aspect, func(t *testing.T) {
				o := DefaultOptions()
				o.Action = ActionRender
				o.Lines = testLines()
				o.Aspect, o.Height = aspect, 720
				o.Look.Background = bg
				o.Look.Title, o.Look.Artist = "Song One", "The Band"
				switch bg {
				case "image":
					o.Look.BackgroundPath = f.cover
				case "video":
					o.Look.BackgroundPath = f.video
				}
				if bg == "gradient" {
					o.Look.Visualizer = "bars"
				}
				if bg == "color" {
					o.Look.Visualizer = "wave"
				}
				res, outs := f.run(t, f.song, o)
				if len(res.Outputs) != 2 || len(outs) != 2 {
					t.Fatalf("outputs = %v / %v", res.Outputs, outs)
				}
				w, h := canvasSize(aspect, 720)
				if got := probeVal(t, f.ffprobe, res.Outputs[0], "-select_streams", "v:0", "-show_entries", "stream=width,height"); got != fmt.Sprintf("%d,%d", w, h) {
					t.Errorf("size = %s, want %dx%d", got, w, h)
				}
				d, _ := strconv.ParseFloat(probeVal(t, f.ffprobe, res.Outputs[0], "-show_entries", "format=duration"), 64)
				if d < 5.5 || d > 6.6 {
					t.Errorf("duration = %v", d)
				}
				if !strings.HasSuffix(res.Outputs[0], "Song One (lyric video).mp4") || !strings.HasSuffix(res.Outputs[1], "Song One.lrc") {
					t.Errorf("names = %v", res.Outputs)
				}
			})
		}
	}
}

func TestKaraokeFillIsInSync(t *testing.T) {
	f := newFixture(t)
	o := DefaultOptions()
	o.Action = ActionRender
	o.Lines = testLines()
	o.Aspect, o.Height = "16:9", 720
	o.Look.Background = "color"
	o.Look.Color1 = "#101010"
	o.Look.TitleCard = false
	o.Look.ShowNext = false
	res, _ := f.run(t, f.plain, o)
	video := res.Outputs[0]
	// highlight #ffd166
	early := countHighlight(t, f.ffmpeg, video, 0.9, 0xff, 0xd1, 0x66)
	mid := countHighlight(t, f.ffmpeg, video, 2.2, 0xff, 0xd1, 0x66)
	late := countHighlight(t, f.ffmpeg, video, 4.3, 0xff, 0xd1, 0x66)
	before := countHighlight(t, f.ffmpeg, video, 0.2, 0xff, 0xd1, 0x66)
	if before != 0 {
		t.Errorf("highlight before the first line: %d px", before)
	}
	if !(early > 0 && early < mid && mid < late) {
		t.Errorf("fill should grow: %d, %d, %d", early, mid, late)
	}
}

func TestPreviewAndFallbacks(t *testing.T) {
	f := newFixture(t)
	o := DefaultOptions()
	o.Action = ActionPreview
	o.Lines = testLines()
	o.Height = 720
	o.PreviewStartMs = 3500
	res, outs := f.run(t, f.plain, o) // no cover art: gradient fallback
	if len(outs) != 0 || res.PreviewPath == "" {
		t.Fatalf("preview should not register outputs: %v %+v", outs, res)
	}
	if !strings.Contains(filepath.Base(res.PreviewPath), "preview-job1") {
		t.Errorf("preview path = %s", res.PreviewPath)
	}
	d, _ := strconv.ParseFloat(probeVal(t, f.ffprobe, res.PreviewPath, "-show_entries", "format=duration"), 64)
	if d < 2 || d > 3 {
		t.Errorf("preview duration = %v, want ~2.5 (6 s song from 3.5 s)", d)
	}
}

func TestLRCActionReal(t *testing.T) {
	f := newFixture(t)
	o := DefaultOptions()
	o.Action = ActionLRC
	o.Lines = testLines()
	res, outs := f.run(t, f.plain, o)
	if len(outs) != 1 || !strings.HasSuffix(outs[0], "Plain.lrc") || len(res.Outputs) != 1 {
		t.Fatalf("outputs = %v", outs)
	}
	data, _ := os.ReadFile(outs[0])
	if !strings.Contains(string(data), "[00:00.50]<00:00.50>Hello") {
		t.Errorf("lrc:\n%s", data)
	}
}
