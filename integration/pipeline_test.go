//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/media"
	"toolbox/core/pdfium"
	"toolbox/core/pipeline"
	"toolbox/core/store"
	"toolbox/modules/converter"
	"toolbox/modules/pdf"
	"toolbox/modules/pipelines"
	"toolbox/modules/trimmer"
)

// pipelineEnv wires the real store, jobs, runner and a few real tools the way
// main.go does (SPEC.md §13.1 integration). Needs ffmpeg/ffprobe.
type pipelineEnv struct {
	jobs    *core.Jobs
	runner  *pipeline.Runner
	resolve func(string) (string, error)
	lib     string
}

func newPipelineEnv(t *testing.T) *pipelineEnv {
	t.Helper()
	support := t.TempDir()
	paths := core.NewPaths(support)
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(paths.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	em := &recorder{events: map[string]int{}}
	lib := filepath.Join(t.TempDir(), "Library")
	settings, err := core.NewSettingsService(db, em, lib)
	if err != nil {
		t.Fatal(err)
	}
	settings.SetSupportDir(paths.SupportDir)
	reg := core.NewRegistry()
	depSvc := deps.New(paths.BinDir, deps.Catalog(), reg, em)
	jobs := core.NewJobs(db, db, reg, em, depSvc.Resolve, settings.Current, paths.TmpDir)
	for _, id := range []string{deps.FFmpeg, deps.FFprobe} {
		if _, err := depSvc.Resolve(id); err != nil {
			depSvc.Detect(context.Background())
			if _, err := depSvc.Resolve(id); err != nil {
				t.Skipf("%s not available: %v", id, err)
			}
		}
	}
	runner := pipeline.New(pipeline.Config{Store: db, Outputs: db, Jobs: jobs, Reg: reg, Em: em,
		Tools: depSvc.Resolve, Settings: settings.Current, ProtectedDirs: []string{paths.SupportDir}})
	renderer := pdfium.New(filepath.Join(paths.CacheDir, "pdfium"))
	t.Cleanup(func() { renderer.Close() })
	for _, f := range []func() error{
		func() error { return converter.Register(reg) },
		func() error { return trimmer.Register(reg, depSvc.Resolve) },
		func() error { return pdf.Register(reg, pdf.New(renderer)) },
		func() error {
			_, err := pipelines.Register(reg, pipelines.Config{Runner: runner, Outputs: db, Emitter: em,
				LibraryDir: func() string { return settings.Current().LibraryDir }})
			return err
		},
	} {
		if err := f(); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = jobs.Shutdown(5 * time.Second) })
	if err := runner.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runner.Stop)
	return &pipelineEnv{jobs: jobs, runner: runner, resolve: depSvc.Resolve, lib: lib}
}

func optionsJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (e *pipelineEnv) save(t *testing.T, p core.Pipeline) core.Pipeline {
	t.Helper()
	entry, err := e.runner.Save(p)
	if err != nil {
		t.Fatal(err)
	}
	if !entry.Check.Ready {
		t.Fatalf("pipeline not ready: %+v", entry.Check)
	}
	return entry.Pipeline
}

// waitRun polls until the run is finished (or the predicate holds).
func (e *pipelineEnv) waitRun(t *testing.T, id string, done func(core.PipelineRun) bool) core.PipelineRun {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for {
		r, err := e.runner.Run(id)
		if err != nil {
			t.Fatal(err)
		}
		if done(r) {
			return r
		}
		if time.Now().After(deadline) {
			t.Fatalf("run %s stuck: %+v", id, r)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func finished(r core.PipelineRun) bool {
	switch r.Status {
	case core.RunDone, core.RunPartial, core.RunFailed, core.RunCancelled:
		return true
	}
	return false
}

func (e *pipelineEnv) ffmpeg(t *testing.T, args ...string) {
	t.Helper()
	bin, err := e.resolve(deps.FFmpeg)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(bin, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, out)
	}
}

func step(id, typ, from, opts string, keep bool) core.PipelineStep {
	return core.PipelineStep{ID: id, Type: typ, From: from, OptionsJSON: opts, Keep: keep}
}

func TestPipelineConvertThenRename(t *testing.T) {
	e := newPipelineEnv(t)
	in := filepath.Join(t.TempDir(), "tone.wav")
	e.ffmpeg(t, "-f", "lavfi", "-i", "sine=frequency=440:duration=2", in)

	conv := converter.DefaultOptions()
	conv.Preset = "mp3-320"
	p := e.save(t, core.Pipeline{Name: "Convert and rename", Steps: []core.PipelineStep{
		step("conv0001", "converter", "input", optionsJSON(t, conv), false),
		step("name0001", pipelines.TypeRename, "conv0001", optionsJSON(t, pipelines.RenameStep{Template: "{name} · copy"}), true),
	}})
	started := time.Now()
	run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: []string{in}}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	run = e.waitRun(t, run.ID, finished)
	t.Logf("convert → rename took %s", time.Since(started))
	if run.Status != core.RunDone {
		t.Fatalf("status %s: %+v", run.Status, run.Items)
	}
	files := run.Items[0].Cells[1].Files
	if len(files) != 1 || filepath.Base(files[0].Path) != "tone · copy.mp3" {
		t.Fatalf("renamed files = %+v", files)
	}
	if _, err := os.Stat(files[0].Path); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
	if _, err := os.Stat(in); err != nil {
		t.Fatalf("input was touched: %v", err)
	}
}

func TestPipelineTrimFirstSeconds(t *testing.T) {
	e := newPipelineEnv(t)
	in := filepath.Join(t.TempDir(), "clip.mp4")
	e.ffmpeg(t, "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=12", "-f", "lavfi", "-i", "sine=duration=12",
		"-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", in)
	opts := trimmer.DefaultStepOptions()
	opts.Keep, opts.Seconds = trimmer.KeepFirst, 5
	p := e.save(t, core.Pipeline{Name: "First five", Steps: []core.PipelineStep{
		step("trim0001", "trimmer", "input", optionsJSON(t, opts), true),
	}})
	run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: []string{in}}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	run = e.waitRun(t, run.ID, finished)
	if run.Status != core.RunDone {
		t.Fatalf("status %s: %+v", run.Status, run.Items)
	}
	files := run.Items[0].Cells[0].Files
	if len(files) != 1 {
		t.Fatalf("files = %+v", files)
	}
	probe, _ := e.resolve(deps.FFprobe)
	info, err := media.Probe(context.Background(), probe, files[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if d := info.DurationMs; d < 4800 || d > 5200 {
		t.Fatalf("duration = %d ms, want ≈ 5000", d)
	}
}

func writeSolidPNG(t *testing.T, path string, c color.Color) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 400, 560))
	for y := 0; y < 560; y++ {
		for x := 0; x < 400; x++ {
			img.Set(x, y, c)
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func TestPipelineImagesToPDFThenCompress(t *testing.T) {
	e := newPipelineEnv(t)
	dir := t.TempDir()
	var inputs []string
	for i, c := range []color.Color{color.White, color.Gray{200}, color.RGBA{200, 220, 255, 255}} {
		p := filepath.Join(dir, "page"+string(rune('1'+i))+".png")
		writeSolidPNG(t, p, c)
		inputs = append(inputs, p)
	}
	merge := pdf.DefaultStepOptions()
	merge.Action = pdf.ActionImagesToPDF
	compress := pdf.DefaultStepOptions()
	compress.Action = pdf.ActionCompress
	p := e.save(t, core.Pipeline{Name: "Pages to PDF", Steps: []core.PipelineStep{
		step("pdf00001", "pdf", "input", optionsJSON(t, merge), false),
		step("pdf00002", "pdf", "pdf00001", optionsJSON(t, compress), true),
	}})
	run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: inputs}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	run = e.waitRun(t, run.ID, finished)
	if run.Status != core.RunDone {
		t.Fatalf("status %s: %+v", run.Status, run.Items)
	}
	var merged *core.RunItem
	for i := range run.Items {
		if len(run.Items[i].Merged) > 0 {
			merged = &run.Items[i]
		}
	}
	if merged == nil || len(merged.Merged) != 3 {
		t.Fatalf("no merged item: %+v", run.Items)
	}
	out := merged.Cells[1].Files
	if len(out) != 1 || !strings.HasSuffix(strings.ToLower(out[0].Path), ".pdf") {
		t.Fatalf("final files = %+v", out)
	}
	if _, err := os.Stat(out[0].Path); err != nil {
		t.Fatalf("final PDF missing: %v", err)
	}
}

func TestPipelineManualStepAdoptsDirectJob(t *testing.T) {
	e := newPipelineEnv(t)
	in := filepath.Join(t.TempDir(), "voice.wav")
	e.ffmpeg(t, "-f", "lavfi", "-i", "sine=frequency=220:duration=1", in)
	p := e.save(t, core.Pipeline{Name: "By hand", Steps: []core.PipelineStep{
		{ID: "hand0001", Type: "converter", From: "input", OptionsJSON: "{}", Manual: true, AutoContinue: true, Keep: true},
	}})
	run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: []string{in}}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	e.waitRun(t, run.ID, func(r core.PipelineRun) bool { return r.NeedsYou == 1 })
	// The user runs the tool by hand on the same file.
	conv := converter.DefaultOptions()
	conv.Preset = "flac"
	if _, err := e.jobs.Submit(context.Background(), converter.ModuleID, []string{in}, optionsJSON(t, conv)); err != nil {
		t.Fatal(err)
	}
	run = e.waitRun(t, run.ID, finished)
	if run.Status != core.RunDone {
		t.Fatalf("status %s: %+v", run.Status, run.Items)
	}
	files := run.Items[0].Cells[0].Files
	if len(files) != 1 || filepath.Ext(files[0].Path) != ".flac" {
		t.Fatalf("adopted files = %+v", files)
	}
}
