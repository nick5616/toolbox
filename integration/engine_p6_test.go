//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/eraser"
	"toolbox/modules/lyricvideo"
	"toolbox/modules/redact"
	"toolbox/modules/subtitles"
)

// mainCheckout is where the untracked .dev folder lives when the test runs
// from a git worktree.
const mainCheckout = "C:/Users/nickb/repos/toolbox"

// devPath resolves a file under .dev, first relative to the repo, then in the
// main checkout. It returns "" when the file is absent.
func devPath(parts ...string) string {
	rel := filepath.Join(append([]string{".dev"}, parts...)...)
	for _, root := range []string{"..", mainCheckout} {
		p, err := filepath.Abs(filepath.Join(root, rel))
		if err != nil {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

const zooWords = "All right, so here we are in front of the elephants. The cool thing about these guys is that they have really, really, really long trunks. And that's cool. And that's pretty much all there is to say."

// submitJSON submits a job with typed options and waits for it.
func submitJSON(t *testing.T, ctx context.Context, jobs *core.Jobs, module string, inputs []string, opts any) core.Job {
	t.Helper()
	raw, err := json.Marshal(opts)
	if err != nil {
		t.Fatal(err)
	}
	created, err := jobs.Submit(ctx, module, inputs, string(raw))
	if err != nil {
		t.Fatalf("submit %s: %v", module, err)
	}
	return waitJob(t, ctx, jobs, created[0].ID)
}

func decodeResult[T any](t *testing.T, j core.Job) T {
	t.Helper()
	var r T
	if err := json.Unmarshal([]byte(j.ResultJSON), &r); err != nil {
		t.Fatalf("%s result %q: %v", j.ModuleID, j.ResultJSON, err)
	}
	return r
}

// modelProvider is the part of core.ModelProvider the test needs.
type modelProvider interface {
	FetchModel(ctx context.Context, job *core.JobContext, preset string) error
}

// fetchModel downloads a model the way the pack installer does, outside a job.
func fetchModel(t *testing.T, ctx context.Context, depSvc *deps.Service, mp modelProvider, preset string) {
	t.Helper()
	start := time.Now()
	jc := core.NewJobContext(core.JobContext{ID: "model-" + preset, TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(float64, string) {},
		Log:      func(core.LogStream, string) {},
		Title:    func(string) {},
		Output:   func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
		Tool:     depSvc.Resolve,
		Result:   func(json.RawMessage) {},
	})
	if err := mp.FetchModel(ctx, jc, preset); err != nil {
		t.Fatalf("fetch %s model: %v", preset, err)
	}
	t.Logf("model %q downloaded in %s", preset, time.Since(start).Round(time.Second))
}

func ffmpegRun(t *testing.T, ffmpeg string, args ...string) {
	t.Helper()
	full := append([]string{"-hide_banner", "-y", "-loglevel", "error"}, args...)
	if o, err := proc.Output(context.Background(), 2*time.Minute, ffmpeg, full...); err != nil {
		t.Fatalf("ffmpeg %v: %v\n%s", args, err, o)
	}
}

func probeDuration(t *testing.T, ffprobe, path string) float64 {
	t.Helper()
	o, err := proc.Output(context.Background(), 30*time.Second, ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := strconv.ParseFloat(strings.TrimSpace(o), 64)
	return f
}

// runPhase6 exercises the Phase 6 engine paths: voice isolation, subtitle
// generation, lyric alignment, Redact and Object Eraser. speech may be "".
func runPhase6(t *testing.T, ctx context.Context, jobs *core.Jobs, depSvc *deps.Service, paths core.Paths,
	cleanupMod *audiocleanup.Module, redactMod *redact.Module, maskDir, speech string) {
	t.Helper()
	ffmpeg, err := depSvc.Resolve(deps.FFmpeg)
	if err != nil {
		t.Errorf("phase 6 steps need FFmpeg: %v", err)
		return
	}
	ffprobe, err := depSvc.Resolve("ffprobe")
	if err != nil {
		ffprobe = filepath.Join(filepath.Dir(ffmpeg), "ffprobe")
	}
	before, _ := sidecar.ModelsUsage(paths)

	t.Run("audio-cleanup-voice", func(t *testing.T) { cleanupVoice(t, ctx, jobs, depSvc, cleanupMod, ffmpeg, speech) })
	t.Run("subtitles-generate", func(t *testing.T) { subtitlesGenerate(t, ctx, jobs, speech) })
	t.Run("lyric-video-align", func(t *testing.T) { lyricAlign(t, ctx, jobs, speech) })
	t.Run("redact", func(t *testing.T) { redactAll(t, ctx, jobs, depSvc, redactMod, ffmpeg, ffprobe) })
	t.Run("eraser", func(t *testing.T) { eraserBoth(t, ctx, jobs, maskDir) })

	if after, err := sidecar.ModelsUsage(paths); err == nil {
		t.Logf("models on disk: %.0f MiB before phase 6, %.0f MiB after (+%.0f MiB)",
			float64(before)/(1<<20), float64(after)/(1<<20), float64(after-before)/(1<<20))
	}
}

// -- 1. Audio Cleanup --------------------------------------------------------

func cleanupVoice(t *testing.T, ctx context.Context, jobs *core.Jobs, depSvc *deps.Service, mod *audiocleanup.Module, ffmpeg, speech string) {
	input := speech
	if input == "" {
		input = filepath.Join(t.TempDir(), "talk.wav")
		ffmpegRun(t, ffmpeg, "-f", "lavfi", "-i", "sine=f=220:r=44100:d=30", "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.02:r=44100:d=30",
			"-filter_complex", "[0]tremolo=f=4:d=0.7,volume=0.2[s];[s][1]amix=inputs=2:normalize=0[a]", "-map", "[a]", "-ac", "1", input)
	}
	fetchModel(t, ctx, depSvc, mod, audiocleanup.PresetVoice)
	start := time.Now()
	o := audiocleanup.DefaultOptions() // voice isolation + podcast loudness
	j := submitJSON(t, ctx, jobs, audiocleanup.ModuleID, []string{input}, o)
	res := decodeResult[audiocleanup.Result](t, j)
	t.Logf("audio-cleanup (voice, podcast) in %s: %s", time.Since(start).Round(time.Second), j.Message)
	if len(res.Files) != 1 || len(j.Outputs) != 1 {
		t.Fatalf("cleanup result %+v outputs %+v", res, j.Outputs)
	}
	f := res.Files[0]
	if _, err := os.Stat(f.Output); err != nil {
		t.Errorf("cleanup output missing: %v", err)
	}
	t.Logf("loudness %.1f -> %.1f LUFS, hum %d Hz", f.LUFSBefore, f.LUFSAfter, f.HumHz)
	if math.Abs(f.LUFSAfter-(-16)) > 1 {
		t.Errorf("after-loudness = %.2f LUFS, want -16 +/- 1", f.LUFSAfter)
	}
}

// -- 2. Subtitles ------------------------------------------------------------

var srtTime = regexp.MustCompile(`(\d+):(\d+):(\d+)[,.](\d+) --> (\d+):(\d+):(\d+)[,.](\d+)`)

func srtMs(m []string, off int) int64 {
	v := func(i int) int64 { n, _ := strconv.ParseInt(m[off+i], 10, 64); return n }
	return ((v(0)*60+v(1))*60+v(2))*1000 + v(3)
}

func subtitlesGenerate(t *testing.T, ctx context.Context, jobs *core.Jobs, speech string) {
	if speech == "" {
		t.Skip("dev speech sample not found")
	}
	start := time.Now()
	o := subtitles.DefaultOptions()
	o.Model = "base"
	o.Language = "en"
	j := submitJSON(t, ctx, jobs, subtitles.ModuleID, []string{speech}, o)
	res := decodeResult[subtitles.Result](t, j)
	t.Logf("subtitles generate in %s: %d cues, %s", time.Since(start).Round(time.Second), res.Cues, j.Message)
	var srt string
	for _, p := range res.Outputs {
		if strings.EqualFold(filepath.Ext(p), ".srt") {
			srt = p
		}
	}
	if srt == "" {
		t.Fatalf("no .srt in outputs %v", res.Outputs)
	}
	b, err := os.ReadFile(srt)
	if err != nil {
		t.Fatal(err)
	}
	cues := 0
	for _, block := range strings.Split(strings.ReplaceAll(strings.TrimSpace(string(b)), "\r\n", "\n"), "\n\n") {
		lines := strings.Split(block, "\n")
		var m []string
		textStart := 0
		for i, l := range lines {
			if m = srtTime.FindStringSubmatch(l); m != nil {
				textStart = i + 1
				break
			}
		}
		if m == nil {
			t.Errorf("cue block without timing: %q", block)
			continue
		}
		cues++
		text := lines[textStart:]
		if len(text) == 0 || len(text) > 2 {
			t.Errorf("cue %d has %d lines: %q", cues, len(text), block)
		}
		for _, l := range text {
			if n := len([]rune(l)); n > 42 {
				t.Errorf("cue %d line is %d chars (> 42): %q", cues, n, l)
			}
		}
		if d := srtMs(m, 5) - srtMs(m, 1); d > 7000 || d <= 0 {
			t.Errorf("cue %d lasts %d ms", cues, d)
		}
	}
	if cues == 0 {
		t.Error("srt has no cues")
	}
}

// -- 3. Lyric Video ----------------------------------------------------------

func lyricAlign(t *testing.T, ctx context.Context, jobs *core.Jobs, speech string) {
	if speech == "" {
		t.Skip("dev speech sample not found")
	}
	start := time.Now()
	o := lyricvideo.DefaultOptions()
	o.Action = lyricvideo.ActionLyrics
	o.Source = lyricvideo.SourceAlign
	o.Language = "en"
	o.Text = zooWords
	j := submitJSON(t, ctx, jobs, lyricvideo.ModuleID, []string{speech}, o)
	res := decodeResult[lyricvideo.Result](t, j)
	t.Logf("lyric-video align (vocal isolation + transcription + align) in %s: %d lines, matched %.2f, %s",
		time.Since(start).Round(time.Second), len(res.Lines), res.Matched, j.Message)
	if len(res.Lines) == 0 {
		t.Fatal("no lyric lines")
	}
	for i, l := range res.Lines {
		t.Logf("  %5.1fs  %s", float64(l.StartMs)/1000, l.Text)
		if i > 0 && l.StartMs <= res.Lines[i-1].StartMs {
			t.Errorf("line %d starts at %d ms, not after line %d (%d ms)", i, l.StartMs, i-1, res.Lines[i-1].StartMs)
		}
	}
	if res.Matched < 0.5 {
		t.Errorf("matched = %.2f, want >= 0.5", res.Matched)
	}
}

// -- 4. Redact ---------------------------------------------------------------

func redactAll(t *testing.T, ctx context.Context, jobs *core.Jobs, depSvc *deps.Service, mod *redact.Module, ffmpeg, ffprobe string) {
	fetchModel(t, ctx, depSvc, mod, redact.PresetFaces)
	fetchModel(t, ctx, depSvc, mod, redact.PresetPlates)

	crew := devPath("p6-research", "samples", "STS-125_crew_portrait.jpg")
	plates := []string{
		devPath("p6-research", "samples", "car_mill_street_newport_geograph_6277432.jpg"),
		devPath("p6-research", "samples", "car_park_sainsburys_geograph_3646022.jpg"),
	}
	if crew == "" {
		t.Log("skipping redact faces: crew portrait not found")
	} else {
		start := time.Now()
		o := redact.DefaultOptions()
		o.Plates = false
		j := submitJSON(t, ctx, jobs, redact.ModuleID, []string{crew}, o)
		res := decodeResult[redact.Result](t, j)
		faces := 0
		for _, d := range res.Images {
			for _, b := range d.Boxes {
				if b.Kind == "face" {
					faces++
				}
			}
		}
		t.Logf("redact detect (crew portrait) in %s: %d faces", time.Since(start).Round(time.Millisecond), faces)
		if faces < 7 {
			t.Errorf("found %d faces in the crew portrait, want >= 7", faces)
		}
		redactApply(t, ctx, jobs, crew, res)
	}

	nPlates := 0
	found := false
	for _, p := range plates {
		if p == "" {
			continue
		}
		found = true
		start := time.Now()
		o := redact.DefaultOptions()
		o.Faces = false
		j := submitJSON(t, ctx, jobs, redact.ModuleID, []string{p}, o)
		res := decodeResult[redact.Result](t, j)
		n := 0
		for _, d := range res.Images {
			for _, b := range d.Boxes {
				if b.Kind == "plate" {
					n++
				}
			}
		}
		t.Logf("redact detect (%s) in %s: %d plates", filepath.Base(p), time.Since(start).Round(time.Millisecond), n)
		nPlates += n
		redactApply(t, ctx, jobs, p, res)
	}
	if !found {
		t.Log("skipping redact plates: car-park photos not found")
	} else if nPlates < 1 {
		t.Errorf("found %d plates across the car-park photos, want >= 1", nPlates)
	}

	// Video: 5 s testsrc, nothing to find; auto must succeed and keep the duration.
	clip := filepath.Join(t.TempDir(), "clip.mp4")
	ffmpegRun(t, ffmpeg, "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=5",
		"-f", "lavfi", "-i", "sine=f=440:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip)
	start := time.Now()
	o := redact.DefaultOptions()
	o.Action = redact.ActionAuto
	j := submitJSON(t, ctx, jobs, redact.ModuleID, []string{clip}, o)
	res := decodeResult[redact.Result](t, j)
	t.Logf("redact auto (5 s video) in %s: %s", time.Since(start).Round(time.Millisecond), j.Message)
	if len(res.Outputs) != 1 {
		t.Fatalf("video outputs = %v", res.Outputs)
	}
	if d := probeDuration(t, ffprobe, res.Outputs[0]); math.Abs(d-5) > 0.1 {
		t.Errorf("redacted video duration = %.3f s, want 5 +/- 0.1", d)
	}
}

// redactApply applies the detected boxes to one image and checks the output.
func redactApply(t *testing.T, ctx context.Context, jobs *core.Jobs, path string, det redact.Result) {
	t.Helper()
	o := redact.DefaultOptions()
	o.Action = redact.ActionApply
	o.ImageBoxes = map[string][]redact.Box{}
	for _, d := range det.Images {
		boxes := d.Boxes
		for i := range boxes {
			boxes[i].Enabled = true
		}
		o.ImageBoxes[d.Path] = boxes
	}
	start := time.Now()
	j := submitJSON(t, ctx, jobs, redact.ModuleID, []string{path}, o)
	res := decodeResult[redact.Result](t, j)
	if len(res.Outputs) != 1 {
		t.Errorf("apply outputs = %v", res.Outputs)
		return
	}
	if _, err := os.Stat(res.Outputs[0]); err != nil {
		t.Errorf("apply output missing: %v", err)
	}
	t.Logf("redact apply (%s) in %s", filepath.Base(path), time.Since(start).Round(time.Millisecond))
}

// -- 5. Object Eraser --------------------------------------------------------

func eraserBoth(t *testing.T, ctx context.Context, jobs *core.Jobs, maskDir string) {
	const w, h = 1024, 768
	square := image.Rect(448, 320, 576, 448)
	dir := t.TempDir()
	src := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			v := uint8(120 + 90*x/w + 20*y/h)
			src.SetNRGBA(x, y, color.NRGBA{v, v, v, 255})
		}
	}
	draw.Draw(src, square, image.NewUniform(color.NRGBA{20, 20, 20, 255}), image.Point{}, draw.Src)
	in := filepath.Join(dir, "scene.png")
	writePNG(t, in, src)

	if err := os.MkdirAll(maskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for i, model := range []eraser.Model{eraser.ModelFast, eraser.ModelBest} {
		mask := image.NewGray(image.Rect(0, 0, w, h))
		draw.Draw(mask, square.Inset(-6), image.NewUniform(color.Gray{255}), image.Point{}, draw.Src)
		maskPath := filepath.Join(maskDir, fmt.Sprintf("e2e-mask-%d.png", i))
		mf, err := os.Create(maskPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(mf, mask); err != nil {
			t.Fatal(err)
		}
		mf.Close()

		start := time.Now()
		j := submitJSON(t, ctx, jobs, eraser.ModuleID, []string{in}, eraser.Options{Model: model, MaskPath: maskPath})
		took := time.Since(start)
		res := decodeResult[eraser.Result](t, j)
		t.Logf("eraser %s in %s (incl. model download): %s", model, took.Round(time.Millisecond), j.Message)
		if model == eraser.ModelBest {
			t.Logf("eraser best time: %s", took.Round(time.Millisecond))
		}
		if _, err := os.Stat(maskPath); err == nil {
			t.Errorf("%s: mask file still exists after the job", model)
		}
		if len(res.Outputs) != 1 {
			t.Errorf("%s: outputs = %v", model, res.Outputs)
			continue
		}
		f, err := os.Open(res.Outputs[0])
		if err != nil {
			t.Errorf("%s: output missing: %v", model, err)
			continue
		}
		out, err := png.Decode(f)
		f.Close()
		if err != nil {
			t.Errorf("%s: output isn't a PNG: %v", model, err)
			continue
		}
		if out.Bounds() != src.Bounds() {
			t.Errorf("%s: output size %v", model, out.Bounds())
			continue
		}
		meanIn := meanLuma(out, square)
		surround := meanLuma(src, square.Inset(-30))
		surroundOnly := (surround*float64(square.Inset(-30).Dx()*square.Inset(-30).Dy()) - 20*float64(square.Dx()*square.Dy())) /
			float64(square.Inset(-30).Dx()*square.Inset(-30).Dy()-square.Dx()*square.Dy())
		t.Logf("%s: square brightness 20 -> %.0f (surroundings %.0f)", model, meanIn, surroundOnly)
		if meanIn < 20+0.6*(surroundOnly-20) {
			t.Errorf("%s: square mean %.0f didn't move toward the surroundings (%.0f)", model, meanIn, surroundOnly)
		}
		// Far outside the mask (>= 100 px away) must be identical.
		far, diff := 0, 0
		for y := range h {
			for x := range w {
				if x > square.Min.X-100 && x < square.Max.X+100 && y > square.Min.Y-100 && y < square.Max.Y+100 {
					continue
				}
				far++
				a, b := color.NRGBAModel.Convert(out.At(x, y)).(color.NRGBA), src.NRGBAAt(x, y)
				if a != b {
					diff++
				}
			}
		}
		if diff != 0 {
			t.Errorf("%s: %d of %d pixels far outside the mask changed", model, diff, far)
		}
	}
}

func meanLuma(im image.Image, r image.Rectangle) float64 {
	var sum float64
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			c := color.GrayModel.Convert(im.At(x, y)).(color.Gray)
			sum += float64(c.Y)
		}
	}
	return sum / float64(r.Dx()*r.Dy())
}
