//go:build integration

package integration

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/pdfium"
	"toolbox/core/sidecar"
	"toolbox/core/store"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/stems"
	"toolbox/modules/transcribe"
	"toolbox/modules/upscale"
)

// writeTestTrack writes a 16 s, 44.1 kHz mono WAV: a C–F–G–C progression of
// sine triads (one bar each, 120 BPM) with a click on every beat.
func writeTestTrack(t *testing.T, path string) {
	t.Helper()
	const rate, seconds, bpm = 44100, 16, 120
	chords := [][]float64{
		{261.63, 329.63, 392.00}, // C4 E4 G4
		{349.23, 440.00, 523.25}, // F4 A4 C5
		{392.00, 493.88, 587.33}, // G4 B4 D5
		{261.63, 329.63, 392.00}, // C4 E4 G4
	}
	n := rate * seconds
	samples := make([]int16, n)
	beat := 60.0 / bpm
	bar := beat * 4
	for i := range n {
		ts := float64(i) / rate
		ch := chords[int(ts/bar)%len(chords)]
		v := 0.0
		for _, f := range ch {
			v += 0.18 * math.Sin(2*math.Pi*f*ts)
		}
		if since := math.Mod(ts, beat); since < 0.03 {
			v += 0.6 * math.Sin(2*math.Pi*1000*ts) * (1 - since/0.03)
		}
		samples[i] = int16(math.Max(-1, math.Min(1, v)) * 32000)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	dataLen := uint32(n * 2)
	hdr := []any{
		[]byte("RIFF"), 36 + dataLen, []byte("WAVE"),
		[]byte("fmt "), uint32(16), uint16(1), uint16(1), uint32(rate), uint32(rate * 2), uint16(2), uint16(16),
		[]byte("data"), dataLen,
	}
	for _, h := range hdr {
		if err := binary.Write(f, binary.LittleEndian, h); err != nil {
			t.Fatal(err)
		}
	}
	if err := binary.Write(f, binary.LittleEndian, samples); err != nil {
		t.Fatal(err)
	}
}

func waitJob(t *testing.T, ctx context.Context, jobs *core.Jobs, id string) core.Job {
	t.Helper()
	for {
		j, err := jobs.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if j.Status.Finished() {
			if j.Status != core.JobDone {
				logs, _ := jobs.Logs(ctx, id)
				for _, l := range logs[max(0, len(logs)-40):] {
					t.Logf("[%s] %s", l.Stream, l.Text)
				}
				t.Fatalf("job %s (%s) %s: %s — %s", id, j.ModuleID, j.Status, j.Error, j.ErrorHint)
			}
			return j
		}
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s (%s): %s", id, j.ModuleID, j.Message)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// TestEndToEndAudioEngine installs the audio engine from scratch (real uv
// download + uv sync, ~1 GB) into a temp support dir, then runs stems,
// BPM & key, audio-to-MIDI and transcription through the job system.
func TestEndToEndAudioEngine(t *testing.T) {
	if os.Getenv("TOOLBOX_ENGINE_E2E") == "" {
		t.Skip("set TOOLBOX_ENGINE_E2E=1 (downloads ~1 GB)")
	}
	support := t.TempDir()
	paths := core.NewPaths(support)
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(paths.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	em := &recorder{events: map[string]int{}}
	settings, err := core.NewSettingsService(db, em, filepath.Join(t.TempDir(), "Library"))
	if err != nil {
		t.Fatal(err)
	}
	reg := core.NewRegistry()
	depSvc := deps.New(paths.BinDir, deps.Catalog(), reg, em)
	jobs := core.NewJobs(db, db, reg, em, depSvc.Resolve, settings.Current, paths.TmpDir)
	engine := sidecar.NewManager(paths, func() (string, error) { return depSvc.Resolve(sidecar.DepID) }, em)
	defer engine.Stop()
	pdfRenderer := pdfium.New(filepath.Join(paths.CacheDir, "pdfium"))
	defer pdfRenderer.Close()
	depSvc.RegisterVirtual(deps.Spec{ID: sidecar.DepID, Name: "AI engine", Managed: true},
		func(ctx context.Context) core.DepStatus { return sidecar.Detect(ctx, paths) })
	// Force a real uv download: resolve uv only from the managed bin dir.
	resolveUV := func() (string, error) {
		p := filepath.Join(paths.BinDir, "uv")
		if strings.HasSuffix(os.Args[0], ".exe") {
			p += ".exe"
		}
		if _, err := os.Stat(p); err != nil {
			return "", core.ErrDependencyMissing("uv", "")
		}
		return p, nil
	}
	for _, err := range []error{
		stems.Register(reg, engine), bpmkey.Register(reg, engine), midi.Register(reg, engine),
		transcribe.Register(reg, engine, paths.ModelsDir),
		bgremove.Register(reg, engine, paths.ModelsDir), upscale.Register(reg, engine, paths.ModelsDir),
		ocr.Register(reg, engine, pdfRenderer, paths.ModelsDir),
		sidecar.RegisterSetup(reg, paths, engine, resolveUV,
			func(ctx context.Context, job *core.JobContext) error {
				return depSvc.InstallManagedBinary(ctx, job, deps.UVBinary())
			},
			func(ctx context.Context) { depSvc.Detect(ctx) }),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer jobs.Shutdown(10 * time.Second)

	if st := sidecar.Detect(ctx, paths); st.State != core.DepMissing {
		t.Fatalf("fresh engine state = %s", st.State)
	}
	setupStart := time.Now()
	created, err := jobs.Submit(ctx, sidecar.SetupModuleID, nil, "{}")
	if err != nil {
		t.Fatal(err)
	}
	setup := waitJob(t, ctx, jobs, created[0].ID)
	st := sidecar.Detect(ctx, paths)
	t.Logf("engine installed in %s: %s (%s)", time.Since(setupStart).Round(time.Second), st.Version, setup.Message)
	if st.State != core.DepOK {
		t.Fatalf("engine state after setup = %+v", st)
	}

	track := filepath.Join(t.TempDir(), "Test Track.wav")
	writeTestTrack(t, track)

	// BPM & key.
	start := time.Now()
	created, err = jobs.Submit(ctx, bpmkey.ModuleID, []string{track}, "{}")
	if err != nil {
		t.Fatal(err)
	}
	bk := waitJob(t, ctx, jobs, created[0].ID)
	var res bpmkey.Result
	if err := json.Unmarshal([]byte(bk.ResultJSON), &res); err != nil {
		t.Fatalf("bpm result %q: %v", bk.ResultJSON, err)
	}
	t.Logf("bpm-key in %s (incl. engine cold start): %s", time.Since(start).Round(time.Millisecond), bk.Message)
	if math.Abs(res.BPM-120) > 3 || res.Key != "C major" || res.Camelot != "8B" {
		t.Errorf("bpm/key = %.1f %s %s (confidence %.2f)", res.BPM, res.Key, res.Camelot, res.Confidence)
	}

	// Audio → MIDI.
	start = time.Now()
	mopts, _ := json.Marshal(midi.DefaultOptions())
	created, err = jobs.Submit(ctx, midi.ModuleID, []string{track}, string(mopts))
	if err != nil {
		t.Fatal(err)
	}
	mj := waitJob(t, ctx, jobs, created[0].ID)
	t.Logf("midi in %s: %s", time.Since(start).Round(time.Millisecond), mj.Message)
	if len(mj.Outputs) != 1 || filepath.Ext(mj.Outputs[0].Path) != ".mid" {
		t.Errorf("midi outputs = %+v", mj.Outputs)
	}

	// Stems (4 stems · fast; downloads htdemucs ~84 MB on first use).
	start = time.Now()
	sopts, _ := json.Marshal(stems.Options{Preset: stems.PresetFourFast, Format: stems.FormatWAV})
	created, err = jobs.Submit(ctx, stems.ModuleID, []string{track}, string(sopts))
	if err != nil {
		t.Fatal(err)
	}
	sj := waitJob(t, ctx, jobs, created[0].ID)
	t.Logf("stems in %s: %s", time.Since(start).Round(time.Second), sj.Message)
	var names []string
	for _, o := range sj.Outputs {
		names = append(names, o.Name)
		if !strings.HasPrefix(o.Name, "Test Track - ") {
			t.Errorf("stem name %q", o.Name)
		}
	}
	if len(sj.Outputs) != 4 {
		t.Errorf("stems = %v", names)
	}
	if size, _ := sidecar.ModelsUsage(paths); size == 0 {
		t.Error("no models recorded under the support dir")
	}
	if s := engine.Status(); !s.Running {
		t.Errorf("engine not running after jobs: %+v", s)
	}

	// Image tools on the engine (Phase 4): background removal with the fast
	// model on a generated disc, then CPU upscaling with the fast model.
	runImageTools(t, ctx, jobs, t.TempDir())

	// OCR (bundled Latin models, no download): an image with rendered text,
	// then a generated 2-page scanned PDF made searchable.
	runOCR(t, ctx, jobs, pdfRenderer, t.TempDir())

	// Transcribe (base model, ~142 MB on first use): the synthetic track has
	// no speech (0 or few segments must still succeed), then real speech if
	// the dev sample is present.
	topts := transcribe.Options{Model: transcribe.ModelBase, Task: transcribe.TaskTranscribe,
		Formats: transcribe.AllFormats(), VAD: true}
	tj := runTranscribe(t, ctx, jobs, track, topts)
	t.Logf("transcribe (no speech): %s", tj.Message)
	speech, _ := filepath.Abs(filepath.Join("..", ".dev", "library", "Downloads", "Me at the zoo [jNQXAC9IVRw].mp3"))
	if _, err := os.Stat(speech); err != nil {
		t.Logf("skipping speech transcription: %s not found", speech)
		return
	}
	topts.Language = "en"
	start = time.Now()
	tj = runTranscribe(t, ctx, jobs, speech, topts)
	t.Logf("transcribe (speech) in %s: %s", time.Since(start).Round(time.Second), tj.Message)
	for _, o := range tj.Outputs {
		b, err := os.ReadFile(o.Path)
		if err != nil {
			t.Fatal(err)
		}
		switch filepath.Ext(o.Path) {
		case ".txt":
			if !strings.Contains(strings.ToLower(string(b)), "elephant") {
				t.Errorf("transcript doesn't mention elephants: %q", b)
			}
		case ".srt":
			if !strings.HasPrefix(string(b), "1\n00:00:") || !strings.Contains(string(b), " --> ") {
				t.Errorf("srt doesn't parse: %q", b)
			}
		case ".vtt":
			if !strings.HasPrefix(string(b), "WEBVTT") {
				t.Errorf("vtt header: %q", b)
			}
		case ".json":
			var doc struct {
				Language string `json:"language"`
				Segments []struct {
					Start, End float64
					Text       string
				} `json:"segments"`
			}
			if err := json.Unmarshal(b, &doc); err != nil || doc.Language != "en" || len(doc.Segments) == 0 {
				t.Errorf("json transcript: %v %+v", err, doc)
			}
		}
	}
}

func runTranscribe(t *testing.T, ctx context.Context, jobs *core.Jobs, input string, opts transcribe.Options) core.Job {
	t.Helper()
	raw, _ := json.Marshal(opts)
	created, err := jobs.Submit(ctx, transcribe.ModuleID, []string{input}, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, ctx, jobs, created[0].ID)
	var res transcribe.Result
	if err := json.Unmarshal([]byte(j.ResultJSON), &res); err != nil {
		t.Fatalf("transcribe result %q: %v", j.ResultJSON, err)
	}
	if len(j.Outputs) != len(opts.Formats) || len(res.Outputs) != len(opts.Formats) {
		t.Errorf("transcribe outputs = %+v / %v", j.Outputs, res.Outputs)
	}
	return j
}

// runImageTools removes the background of a generated disc (fast model) and
// upscales a small generated image 2× on the CPU (fast model).
func runImageTools(t *testing.T, ctx context.Context, jobs *core.Jobs, dir string) {
	t.Helper()
	disc := filepath.Join(dir, "disc.png")
	im := image.NewNRGBA(image.Rect(0, 0, 320, 240))
	for y := range 240 {
		for x := range 320 {
			c := color.NRGBA{235, 238, 240, 255} // light backdrop
			if dx, dy := x-160, y-120; dx*dx+dy*dy < 70*70 {
				c = color.NRGBA{200, 40, 30, 255} // red subject
			}
			im.SetNRGBA(x, y, c)
		}
	}
	writePNG(t, disc, im)

	start := time.Now()
	raw, _ := json.Marshal(bgremove.Options{Model: bgremove.ModelFast, Output: bgremove.OutputTransparent, CleanEdges: true, Color: "#ffffff"})
	created, err := jobs.Submit(ctx, bgremove.ModuleID, []string{disc}, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, ctx, jobs, created[0].ID)
	var br bgremove.Result
	if err := json.Unmarshal([]byte(j.ResultJSON), &br); err != nil || len(j.Outputs) != 1 {
		t.Fatalf("bg-remover result %q outputs %+v: %v", j.ResultJSON, j.Outputs, err)
	}
	// The disc covers π·70²/(320·240) ≈ 20% of the image.
	if br.SubjectCoverage < 0.12 || br.SubjectCoverage > 0.3 || br.Width != 320 || br.Height != 240 {
		t.Errorf("bg-remover result = %+v", br)
	}
	t.Logf("bg-remover (fast) in %s: %s", time.Since(start).Round(time.Second), j.Message)

	small := filepath.Join(dir, "small.png")
	writePNG(t, small, im.SubImage(image.Rect(100, 60, 164, 108)))
	start = time.Now()
	raw, _ = json.Marshal(upscale.Options{Model: upscale.ModelFast, Scale: 2, Format: upscale.FormatPNG, Device: upscale.DeviceCPU})
	created, err = jobs.Submit(ctx, upscale.ModuleID, []string{small}, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	j = waitJob(t, ctx, jobs, created[0].ID)
	var ur upscale.Result
	if err := json.Unmarshal([]byte(j.ResultJSON), &ur); err != nil || len(j.Outputs) != 1 {
		t.Fatalf("upscale result %q outputs %+v: %v", j.ResultJSON, j.Outputs, err)
	}
	if ur.OutWidth != 128 || ur.OutHeight != 96 || ur.Device == "gpu" {
		t.Errorf("upscale result = %+v", ur)
	}
	t.Logf("upscale (cpu, fast, 2x) in %s: %s", time.Since(start).Round(time.Second), j.Message)
}

func writePNG(t *testing.T, path string, im image.Image) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, im); err != nil {
		t.Fatal(err)
	}
}

// textImage draws text with basicfont and scales it up so RapidOCR can read it.
func textImage(text string) image.Image {
	const scale = 6
	w := len(text)*basicfont.Face7x13.Advance + 20
	small := image.NewGray(image.Rect(0, 0, w, 30))
	draw.Draw(small, small.Bounds(), image.White, image.Point{}, draw.Src)
	d := &font.Drawer{Dst: small, Src: image.Black, Face: basicfont.Face7x13, Dot: fixed.P(10, 20)}
	d.DrawString(text)
	big := image.NewGray(image.Rect(0, 0, w*scale, 30*scale))
	for y := range big.Bounds().Dy() {
		for x := range big.Bounds().Dx() {
			big.SetGray(x, y, small.GrayAt(x/scale, y/scale))
		}
	}
	return big
}

// runOCR reads text from an image (TXT) and makes a generated 2-page PDF searchable.
func runOCR(t *testing.T, ctx context.Context, jobs *core.Jobs, r *pdfium.Renderer, dir string) {
	t.Helper()
	img := filepath.Join(dir, "sign.png")
	writePNG(t, img, textImage("Toolbox OCR 2026"))
	start := time.Now()
	raw, _ := json.Marshal(ocr.DefaultOptions())
	created, err := jobs.Submit(ctx, ocr.ModuleID, []string{img}, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, ctx, jobs, created[0].ID)
	var ir ocr.Result
	if err := json.Unmarshal([]byte(j.ResultJSON), &ir); err != nil || len(j.Outputs) != 1 {
		t.Fatalf("ocr image result %q outputs %+v: %v", j.ResultJSON, j.Outputs, err)
	}
	txt, err := os.ReadFile(j.Outputs[0].Path)
	if err != nil || !strings.Contains(strings.ToLower(string(txt)), "toolbox") {
		t.Errorf("ocr image text = %q (%v), preview %q", txt, err, ir.Preview)
	}
	t.Logf("ocr (image) in %s: %s", time.Since(start).Round(time.Second), j.Message)

	p1, p2 := filepath.Join(dir, "page1.png"), filepath.Join(dir, "page2.png")
	writePNG(t, p1, textImage("Toolbox OCR 2026"))
	writePNG(t, p2, textImage("Searchable second page"))
	src := filepath.Join(dir, "scan.pdf")
	c := model.NewStatelessConfiguration()
	if err := api.ImportImagesFile(ctx, []string{p1, p2}, src, nil, c); err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	created, err = jobs.Submit(ctx, ocr.ModuleID, []string{src}, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	j = waitJob(t, ctx, jobs, created[0].ID)
	var pr ocr.Result
	if err := json.Unmarshal([]byte(j.ResultJSON), &pr); err != nil || len(j.Outputs) != 1 {
		t.Fatalf("ocr pdf result %q outputs %+v: %v", j.ResultJSON, j.Outputs, err)
	}
	if pr.Pages != 2 || pr.PagesOcred != 2 || pr.PagesSkipped != 0 {
		t.Errorf("ocr pdf result = %+v", pr)
	}
	out, err := os.ReadFile(j.Outputs[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	for page, want := range map[int]string{1: "toolbox", 2: "searchable"} {
		got, err := r.PageText(ctx, out, "", page)
		if err != nil || !strings.Contains(strings.ToLower(got), want) {
			t.Errorf("searchable pdf page %d text = %q (%v), want %q", page, got, err, want)
		}
	}
	t.Logf("ocr (pdf) in %s: %s", time.Since(start).Round(time.Second), j.Message)
}
