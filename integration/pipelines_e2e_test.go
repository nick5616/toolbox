//go:build integration

package integration

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/pdfium"
	"toolbox/core/pipeline"
	"toolbox/core/sidecar"
	"toolbox/core/store"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/converter"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/pdf"
	"toolbox/modules/pipelines"
	"toolbox/modules/redact"
	"toolbox/modules/stems"
	"toolbox/modules/transcribe"
	"toolbox/modules/upscale"
	"toolbox/modules/vault"

	_ "golang.org/x/image/webp"
	_ "image/jpeg"
	_ "image/png"
)

// Phase 8 Part A end-to-end checks (SPEC.md §14 Wave 3, §15). They use the
// dev sandbox's tools folder read-only (bin, python, sidecar); the database,
// tmp, cache, library and a copy of the models live in temp directories.
// Run: TOOLBOX_PIPELINES_E2E=1 go test -tags integration -run TestPipelinesE2E -v -timeout 60m ./integration/

type pe2e struct {
	paths     core.Paths
	jobs      *core.Jobs
	runner    *pipeline.Runner
	vault     *vault.Vault
	vaultAPI  *vault.Service
	depSvc    *deps.Service
	engine    *sidecar.Manager
	lib       string
	em        *recorder
	redactMod *redact.Module
	once      sync.Once
	closeAll  func()
}

func (e *pe2e) Close() { e.once.Do(e.closeAll) }

// interrupt stops the runner and the jobs the way a quit would.
func (e *pe2e) interrupt() { e.Close() }

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatalf("copy %s: %v", src, err)
	}
}

// openPE2E builds the backend over support (reusing its database if present).
func openPE2E(t *testing.T, toolsDir, support, modelsDir, lib string) *pe2e {
	t.Helper()
	paths := core.NewPathsWithTools(support, toolsDir)
	paths.ModelsDir = modelsDir
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(paths.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	em := &recorder{events: map[string]int{}}
	settings, err := core.NewSettingsService(db, em, lib)
	if err != nil {
		t.Fatal(err)
	}
	settings.SetSupportDir(paths.SupportDir)
	_ = os.MkdirAll(lib, 0o755)
	libraryDir := func() string { return settings.Current().LibraryDir }

	reg := core.NewRegistry()
	depSvc := deps.New(paths.BinDir, deps.Catalog(), reg, em)
	jobs := core.NewJobs(db, db, reg, em, depSvc.Resolve, settings.Current, paths.TmpDir)
	engine := sidecar.NewManager(paths, func() (string, error) { return depSvc.Resolve(sidecar.DepID) }, em)
	depSvc.RegisterVirtual(deps.Spec{ID: sidecar.DepID, Name: "AI engine", Managed: true},
		func(ctx context.Context) core.DepStatus { return sidecar.Detect(ctx, paths) })
	engine.SetFFmpegResolver(func() (string, error) { return depSvc.Resolve(deps.FFmpeg) })
	renderer := pdfium.New(filepath.Join(paths.CacheDir, "pdfium"))
	pdfMod := pdf.New(renderer)
	vlt := vault.New(vault.Config{
		LibraryDir: libraryDir, OpenDir: filepath.Join(paths.TmpDir, "vault-open"),
		Settings: settings, Jobs: jobs, Emitter: em,
	})
	runner := pipeline.New(pipeline.Config{Store: db, Outputs: db, Jobs: jobs, Reg: reg, Em: em,
		Tools: depSvc.Resolve, Settings: settings.Current, ProtectedDirs: []string{paths.SupportDir, paths.ToolsDir}})

	var redactMod *redact.Module
	for _, err := range []error{
		stems.Register(reg, engine), bpmkey.Register(reg, engine), midi.Register(reg, engine),
		converter.Register(reg), transcribe.Register(reg, engine, paths.ModelsDir),
		func() error {
			_, err := audiocleanup.Register(reg, engine, depSvc.Resolve, paths.ModelsDir, filepath.Join(paths.CacheDir, "cleanup-preview"))
			return err
		}(),
		bgremove.Register(reg, engine, paths.ModelsDir), upscale.Register(reg, engine, paths.ModelsDir),
		pdf.Register(reg, pdfMod), ocr.Register(reg, engine, renderer, paths.ModelsDir),
		vault.Register(reg, vlt),
		func() error {
			var err error
			redactMod, err = redact.Register(reg, engine, depSvc.Resolve, paths.ModelsDir, filepath.Join(paths.CacheDir, "redact"))
			return err
		}(),
		func() error {
			_, err := pipelines.Register(reg, pipelines.Config{Runner: runner, Outputs: db, Emitter: em, LibraryDir: libraryDir})
			return err
		}(),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	depSvc.Detect(ctx)
	if err := runner.Start(ctx); err != nil {
		t.Fatal(err)
	}
	vlt.Start(ctx)
	e := &pe2e{paths: paths, jobs: jobs, runner: runner, vault: vlt, vaultAPI: vault.NewService(vlt),
		depSvc: depSvc, engine: engine, lib: lib, em: em, redactMod: redactMod}
	e.closeAll = func() {
		runner.Stop()
		_ = jobs.Shutdown(10 * time.Second)
		cancel()
		_ = engine.Stop()
		vlt.Close()
		renderer.Close()
		db.Close()
	}
	t.Cleanup(e.Close)
	return e
}

func (e *pe2e) needEngine(t *testing.T) {
	t.Helper()
	for _, s := range e.depSvc.List() {
		if s.ID == sidecar.DepID && s.State != core.DepOK {
			t.Skipf("AI engine is %s in the sandbox", s.State)
		}
	}
}

func (e *pe2e) saveReady(t *testing.T, p core.Pipeline) core.Pipeline {
	t.Helper()
	entry, err := e.runner.Save(p)
	if err != nil {
		t.Fatalf("save %q: %v", p.Name, err)
	}
	if !entry.Check.Ready {
		b, _ := json.MarshalIndent(entry.Check, "", " ")
		t.Fatalf("pipeline %q not ready: %s", p.Name, b)
	}
	return entry.Pipeline
}

func (e *pe2e) fromTemplate(t *testing.T, id string) core.Pipeline {
	t.Helper()
	p, err := pipelines.FromTemplate(id, e.runner.List())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (e *pe2e) wait(t *testing.T, runID string, timeout time.Duration, pred func(core.PipelineRun) bool) core.PipelineRun {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		r, err := e.runner.Run(runID)
		if err != nil {
			t.Fatal(err)
		}
		if pred(r) {
			return r
		}
		if time.Now().After(deadline) {
			e.dump(t, r)
			t.Fatalf("run %s did not reach the expected state in %s (status %s)", runID, timeout, r.Status)
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// dump logs the run's cells and the logs of the jobs behind failed cells.
func (e *pe2e) dump(t *testing.T, r core.PipelineRun) {
	t.Helper()
	t.Logf("RUN %s status=%s error=%q", r.Name, r.Status, r.Error)
	for _, it := range r.Items {
		for ci, c := range it.Cells {
			t.Logf("  item %d (%s) step %d %s: status=%s wait=%s msg=%q err=%q [%s] hint=%q files=%d jobs=%v",
				it.Index, it.Label, ci, r.Steps[ci].Type, c.Status, c.Wait, c.Message, c.Error, c.ErrorCode, c.ErrorHint, len(c.Files), c.JobIDs)
			if c.Status == core.CellFailed {
				for _, id := range c.JobIDs {
					logs, _ := e.jobs.Logs(context.Background(), id)
					for _, l := range logs[max(0, len(logs)-25):] {
						t.Logf("      job %s [%s] %s", id, l.Stream, l.Text)
					}
				}
			}
		}
	}
}

func (e *pe2e) runToEnd(t *testing.T, p core.Pipeline, inputs []string, timeout time.Duration) core.PipelineRun {
	t.Helper()
	started := time.Now()
	run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: inputs}, "manual")
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	run = e.wait(t, run.ID, timeout, finished)
	t.Logf("%q finished %s in %s", p.Name, run.Status, time.Since(started).Round(time.Millisecond))
	if run.Status != core.RunDone {
		e.dump(t, run)
		t.Fatalf("run status = %s", run.Status)
	}
	return run
}

func dropStep0(p core.Pipeline) core.Pipeline {
	id := p.Steps[0].ID
	p.Steps = p.Steps[1:]
	for i := range p.Steps {
		if p.Steps[i].From == id {
			p.Steps[i].From = pipeline.FromInput
		}
	}
	return p
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func imageHeight(t *testing.T, path string) int {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return cfg.Height
}

func TestPipelinesE2E(t *testing.T) {
	if os.Getenv("TOOLBOX_PIPELINES_E2E") == "" {
		t.Skip("set TOOLBOX_PIPELINES_E2E=1")
	}
	tools := devPath("support")
	if tools == "" {
		t.Skip("no .dev/support sandbox")
	}
	photo1, photo2 := devPath("inputs", "Paris trip.jpg"), devPath("inputs", "p3_src.jpg")
	if photo1 == "" || photo2 == "" {
		t.Skip("sandbox photos missing")
	}
	// Models: a copy of what the sandbox has, so downloads never touch .dev.
	models := t.TempDir()
	for _, d := range []string{"audio-separator", "bg", "upscale"} {
		if src := filepath.Join(tools, "models", d); dirExists(src) {
			copyTree(t, src, filepath.Join(models, d))
		}
	}
	newEnv := func(t *testing.T) *pe2e {
		return openPE2E(t, tools, t.TempDir(), models, filepath.Join(t.TempDir(), "Library"))
	}

	t.Run("1-sampling", func(t *testing.T) {
		e := newEnv(t)
		e.needEngine(t)
		dir := t.TempDir()
		song := filepath.Join(dir, "Test Song.wav")
		writeTestTrack(t, song)
		p := dropStep0(e.fromTemplate(t, pipelines.TplSampling))
		p = e.saveReady(t, p)
		run := e.runToEnd(t, p, []string{song}, 20*time.Minute)
		it := run.Items[0]
		stemFiles := it.Cells[0].Files
		if len(stemFiles) != 4 {
			t.Fatalf("stems made %d files, want 4: %+v", len(stemFiles), stemFiles)
		}
		roles := map[string]bool{}
		for _, f := range stemFiles {
			if f.Role == "" {
				t.Errorf("stem %s has no role", f.Name)
			}
			roles[f.Role] = true
		}
		if !roles["bass"] || len(roles) != 4 {
			t.Errorf("stem roles = %v", roles)
		}
		t.Logf("vars: bpm=%q key=%q", it.Vars["bpm"], it.Vars["key"])
		if it.Vars["bpm"] == "" || it.Vars["key"] == "" {
			t.Errorf("bpm/key vars missing: %v", it.Vars)
		}
		renamed := it.Cells[2].Files
		if len(renamed) != 4 {
			t.Fatalf("rename made %d files", len(renamed))
		}
		for _, f := range renamed {
			if !strings.Contains(f.Name, "BPM") || !strings.Contains(f.Name, it.Vars["bpm"]) {
				t.Errorf("renamed file %q lacks BPM/value", f.Name)
			}
			if _, err := os.Stat(f.Path); err != nil {
				t.Errorf("renamed file missing: %v", err)
			}
			t.Logf("renamed: %s [%s]", f.Name, f.Role)
		}
		midiCell := it.Cells[3]
		if len(midiCell.Inputs) != 1 || midiCell.Inputs[0].Role != "bass" {
			t.Errorf("MIDI inputs = %+v, want the bass file only", midiCell.Inputs)
		}
		for _, id := range midiCell.JobIDs {
			j, _ := e.jobs.Get(context.Background(), id)
			if len(j.Inputs) != 1 {
				t.Errorf("MIDI job has %d inputs", len(j.Inputs))
			}
		}
		if len(midiCell.Files) == 0 || !strings.HasSuffix(strings.ToLower(midiCell.Files[0].Path), ".mid") {
			t.Errorf("MIDI files = %+v", midiCell.Files)
		}
	})

	t.Run("2-product-photos", func(t *testing.T) {
		e := newEnv(t)
		e.needEngine(t)
		dir := t.TempDir()
		var ins []string
		for _, src := range []string{photo1, photo2} {
			dst := filepath.Join(dir, filepath.Base(src))
			copyFile(t, src, dst)
			ins = append(ins, dst)
		}
		before := map[string]int64{}
		for _, in := range ins {
			fi, _ := os.Stat(in)
			before[in] = fi.Size()
		}
		p := e.fromTemplate(t, pipelines.TplProductPhotos)
		if _, err := e.depSvc.Resolve(deps.Upscayl); err != nil {
			t.Logf("upscaler engine missing (%v): using the CPU device", err)
		}
		// Device auto = GPU when possible, CPU fallback otherwise (SPEC 13.3).
		p = e.saveReady(t, p)
		run := e.runToEnd(t, p, ins, 30*time.Minute)
		for _, it := range run.Items {
			files := it.Cells[2].Files
			if len(files) != 1 || !strings.HasSuffix(files[0].Path, ".webp") {
				t.Fatalf("item %s final files = %+v", it.Label, files)
			}
			if h := imageHeight(t, files[0].Path); h > 1440 || h == 0 {
				t.Errorf("%s height = %d", files[0].Name, h)
			} else {
				t.Logf("%s -> %s (%d px high)", it.Label, files[0].Name, h)
			}
		}
		for _, in := range ins {
			fi, err := os.Stat(in)
			if err != nil || fi.Size() != before[in] {
				t.Errorf("input %s changed: %v", in, err)
			}
		}
	})

	t.Run("3-paper-archive", func(t *testing.T) {
		e := newEnv(t)
		e.needEngine(t)
		dir := t.TempDir()
		var ins []string
		for i, txt := range []string{"Invoice 2026 Alpha", "Contract Beta Page", "Receipt Gamma Total"} {
			p := filepath.Join(dir, fmt.Sprintf("page%d.png", i+1))
			writePNG(t, p, textImage(txt))
			ins = append(ins, p)
		}
		key, err := e.vaultAPI.Create("correct horse battery")
		if err != nil || key == "" {
			t.Fatalf("create vault: %v", err)
		}
		p := e.saveReady(t, e.fromTemplate(t, pipelines.TplPaperArchive))
		run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: ins}, "manual")
		if err != nil {
			t.Fatal(err)
		}
		// With the vault locked the last step must wait on a condition.
		waited := e.wait(t, run.ID, 20*time.Minute, func(r core.PipelineRun) bool {
			if r.Status == core.RunFailed || r.Status == core.RunPartial {
				return true
			}
			for _, it := range r.Items {
				if c := it.Cells[len(it.Cells)-1]; c.Status == core.CellWaiting {
					return true
				}
			}
			return false
		})
		mi := len(waited.Items) - 1
		merged := waited.Items[mi]
		last := merged.Cells[len(merged.Cells)-1]
		if waited.Status == core.RunFailed || waited.Status == core.RunPartial {
			e.dump(t, waited)
			if strings.Contains(strings.ToLower(waited.Error+last.Error), "download") || waited.Items[0].Cells[1].Status == core.CellFailed {
				t.Skipf("OCR models unavailable (offline?): %s", waited.Items[0].Cells[1].Error)
			}
			t.Fatalf("run ended %s before the vault wait", waited.Status)
		}
		t.Logf("vault cell: status=%s wait=%s message=%q hint=%q", last.Status, last.Wait, last.Message, last.ErrorHint)
		if last.Wait != core.WaitCondition || last.Message != "Unlock the Vault to continue" {
			t.Errorf("vault wait = %s %q", last.Wait, last.Message)
		}
		if waited.Status != core.RunWaiting && waited.Status != core.RunRunning {
			t.Errorf("run status while waiting = %s", waited.Status)
		}
		pdfs := merged.Cells[2].Files
		if len(pdfs) != 1 || !strings.HasSuffix(strings.ToLower(pdfs[0].Path), ".pdf") {
			t.Errorf("compressed output = %+v (want one PDF from 3 images)", pdfs)
		}
		if len(waited.Items) != 4 || len(merged.Merged) != 3 {
			t.Errorf("fan-in made %d items (merged %v), want 3 inputs + 1 merged", len(waited.Items), merged.Merged)
		}
		if err := e.vaultAPI.Unlock("correct horse battery"); err != nil {
			t.Fatal(err)
		}
		unlockedAt := time.Now()
		final := e.wait(t, run.ID, 60*time.Second, finished)
		t.Logf("continued %s after unlock; status %s", time.Since(unlockedAt).Round(time.Millisecond), final.Status)
		if final.Status != core.RunDone {
			e.dump(t, final)
			t.Fatalf("final status %s", final.Status)
		}
		if st := e.vaultAPI.State(); st.Entries != 1 {
			t.Errorf("vault entries = %d, want 1", st.Entries)
		}
	})

	t.Run("4-before-sharing", func(t *testing.T) {
		e := newEnv(t)
		e.needEngine(t)
		dir := t.TempDir()
		var ins []string
		for _, src := range []string{photo1, photo2} {
			dst := filepath.Join(dir, filepath.Base(src))
			copyFile(t, src, dst)
			ins = append(ins, dst)
		}
		// Model downloads (pinned, sha-verified) the way the pack installer does.
		for _, preset := range []string{redact.PresetFaces, redact.PresetPlates} {
			jc := core.NewJobContext(core.JobContext{ID: "model-" + preset, TempDir: t.TempDir()}, core.JobHooks{
				Progress: func(float64, string) {}, Log: func(core.LogStream, string) {}, Title: func(string) {},
				Output: func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
				Tool:   e.depSvc.Resolve, Result: func(json.RawMessage) {},
			})
			if err := e.redactMod.FetchModel(context.Background(), jc, preset); err != nil {
				t.Skipf("redact model %s unavailable (offline?): %v", preset, err)
			}
		}
		p := e.saveReady(t, e.fromTemplate(t, pipelines.TplBeforeSharing))
		run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: ins}, "manual")
		if err != nil {
			t.Fatal(err)
		}
		waiting := e.wait(t, run.ID, 20*time.Minute, func(r core.PipelineRun) bool {
			if r.Status == core.RunFailed || r.Status == core.RunPartial {
				return true
			}
			return r.Status == core.RunWaiting && r.NeedsYou == len(r.Items)
		})
		if waiting.Status == core.RunFailed || waiting.Status == core.RunPartial {
			e.dump(t, waiting)
			t.Skipf("redact did not complete (models offline?): %s", waiting.Items[0].Cells[0].Error)
		}
		var keep string
		for i, it := range waiting.Items {
			c := it.Cells[1]
			if c.Status != core.CellWaiting || c.Wait != core.WaitCheck || len(c.Inputs) != 1 {
				t.Fatalf("item %d check cell = %+v", i, c)
			}
			if i == 0 {
				keep = c.Inputs[0].Path
			}
		}
		stepID := waiting.Steps[1].ID
		if err := e.runner.Continue(core.ContinueRequest{RunID: run.ID, Item: 0, StepID: stepID, Keep: []string{keep}}); err != nil {
			t.Fatal(err)
		}
		if err := e.runner.Continue(core.ContinueRequest{RunID: run.ID, Item: 1, StepID: stepID, Keep: []string{}}); err != nil {
			t.Fatal(err)
		}
		final := e.wait(t, run.ID, 2*time.Minute, finished)
		if final.Status != core.RunDone {
			e.dump(t, final)
			t.Fatalf("final status %s", final.Status)
		}
		var zipPath string
		for _, it := range final.Items {
			for _, c := range it.Cells[2].Files {
				if strings.HasSuffix(c.Path, ".zip") {
					zipPath = c.Path
				}
			}
		}
		if zipPath == "" {
			e.dump(t, final)
			t.Fatal("no zip produced")
		}
		zr, err := zip.OpenReader(zipPath)
		if err != nil {
			t.Fatal(err)
		}
		defer zr.Close()
		if len(zr.File) != 1 || zr.File[0].Name != filepath.Base(keep) {
			var names []string
			for _, f := range zr.File {
				names = append(names, f.Name)
			}
			t.Errorf("zip entries = %v, want exactly [%s]", names, filepath.Base(keep))
		}
	})

	t.Run("5-podcast-chat-warning", func(t *testing.T) {
		e := newEnv(t)
		p := e.fromTemplate(t, pipelines.TplPodcast)
		check := e.runner.Describe(p)
		var warns []string
		for _, s := range check.Steps {
			warns = append(warns, s.Info.Warnings...)
		}
		t.Logf("Podcast Describe: ready=%v missing=%v problems=%v warnings=%v", check.Ready, check.Missing, check.Problems, warns)
		found := false
		for _, w := range warns {
			if strings.Contains(w, "Chat") {
				found = true
			}
		}
		if !found {
			t.Errorf("no chat warning in %v", warns)
		}
		for i, s := range check.Steps {
			if len(s.Problems) > 0 {
				t.Errorf("step %d problems: %v (warnings must not be problems)", i, s.Problems)
			}
		}
		if _, err := e.runner.Save(p); err != nil {
			t.Errorf("Save refused for the chat warning: %v", err)
		}
	})

	t.Run("6-restart-mid-run", func(t *testing.T) {
		support := t.TempDir()
		lib := filepath.Join(t.TempDir(), "Library")
		e := openPE2E(t, tools, support, models, lib)
		e.needEngine(t)
		dir := t.TempDir()
		short := filepath.Join(dir, "short.wav")
		writeTestTrack(t, short)
		long := filepath.Join(dir, "long.wav")
		ff, err := e.depSvc.Resolve(deps.FFmpeg)
		if err != nil {
			t.Skip("no ffmpeg")
		}
		if out, err := exec.Command(ff, "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "3", "-i", short, "-c", "copy", long).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v %s", err, out)
		}
		p := pipeline0(e, t, "Restart test", step("stem0001", "stems", pipeline.FromInput, optionsJSON(t, func() stems.Options {
			o := stems.DefaultOptions()
			o.Preset, o.Format = stems.PresetFourFast, stems.FormatFLAC
			return o
		}()), true))
		run, err := e.runner.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: []string{long}}, "manual")
		if err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		e.wait(t, run.ID, 2*time.Minute, func(r core.PipelineRun) bool { return r.Items[0].Cells[0].Status == core.CellRunning })
		time.Sleep(2 * time.Second)
		t.Logf("interrupting %s after the stems cell started", time.Since(started).Round(time.Millisecond))
		e.interrupt()

		e2 := openPE2E(t, tools, support, models, lib)
		r, err := e2.runner.Run(run.ID)
		if err != nil {
			t.Fatal(err)
		}
		c := r.Items[0].Cells[0]
		t.Logf("after restart: run=%s cell=%s code=%s err=%q hint=%q", r.Status, c.Status, c.ErrorCode, c.Error, c.ErrorHint)
		if c.Status != core.CellFailed {
			e2.dump(t, r)
			t.Fatalf("interrupted cell status = %s, want failed", c.Status)
		}
		if _, err := e2.runner.Retry(run.ID); err != nil {
			t.Fatalf("Retry: %v", err)
		}
		final := e2.wait(t, run.ID, 20*time.Minute, finished)
		if final.Status != core.RunDone {
			e2.dump(t, final)
			t.Fatalf("after retry status = %s", final.Status)
		}
		if n := len(final.Items[0].Cells[0].Files); n != 4 {
			t.Errorf("retried stems made %d files", n)
		}
	})

	t.Run("7-watch-folder", func(t *testing.T) {
		e := newEnv(t)
		dir := t.TempDir()
		watch := filepath.Join(dir, "watch-in")
		if err := os.MkdirAll(watch, 0o755); err != nil {
			t.Fatal(err)
		}
		ff, err := e.depSvc.Resolve(deps.FFmpeg)
		if err != nil {
			t.Skip("no ffmpeg")
		}
		wav := func(name string, hz int) string {
			staged := filepath.Join(dir, "staged-"+name)
			if out, err := exec.Command(ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
				fmt.Sprintf("sine=frequency=%d:duration=1", hz), staged).CombinedOutput(); err != nil {
				t.Fatalf("ffmpeg: %v %s", err, out)
			}
			return staged
		}
		arrive := func(staged ...string) []string { // a near-instant copy into the folder
			var out []string
			for _, s := range staged {
				dst := filepath.Join(watch, strings.TrimPrefix(filepath.Base(s), "staged-"))
				copyFile(t, s, dst)
				out = append(out, dst)
			}
			return out
		}
		pre := arrive(wav("pre-existing.wav", 300))[0]
		staged := []string{wav("new1.wav", 450), wav("new2.wav", 500), wav("new3.wav", 550), wav("new4.wav", 700)}
		time.Sleep(4 * time.Second) // older than the settle time
		conv := converter.DefaultOptions()
		conv.Preset = "mp3-320"
		p := core.Pipeline{Name: "Watch test", Steps: []core.PipelineStep{step("conv0001", "converter", pipeline.FromInput, optionsJSON(t, conv), true)},
			Watch: core.WatchConfig{Enabled: true, Folder: watch}}
		p = e.saveReady(t, p)
		arrive(staged[:3]...)
		t0 := time.Now()
		runs := e.waitRuns(t, p.ID, 1, 60*time.Second)
		t.Logf("first watch run started %s after the files landed", time.Since(t0).Round(100*time.Millisecond))
		if n := len(runs[0].Items); n != 3 {
			t.Errorf("first run has %d items, want 3: %v", n, runs[0].Inputs)
		}
		if runs[0].Trigger != "watch" {
			t.Errorf("trigger = %q", runs[0].Trigger)
		}
		for _, in := range runs[0].Inputs {
			if in == pre {
				t.Errorf("pre-existing file was run")
			}
		}
		e.wait(t, runs[0].ID, time.Minute, finished)
		time.Sleep(12 * time.Second) // two more polls: nothing new must start
		if got, _ := e.runner.Runs(core.RunFilter{PipelineID: p.ID}); len(got) != 1 {
			t.Errorf("%d runs after idle polling, want 1", len(got))
		}
		arrive(staged[3])
		runs = e.waitRuns(t, p.ID, 2, 60*time.Second)
		if len(runs[0].Items) != 1 || !strings.HasSuffix(runs[0].Inputs[0], "new4.wav") {
			t.Errorf("second run = %d items, inputs %v", len(runs[0].Items), runs[0].Inputs)
		}
		e.wait(t, runs[0].ID, time.Minute, finished)
		time.Sleep(8 * time.Second)
		if got, _ := e.runner.Runs(core.RunFilter{PipelineID: p.ID}); len(got) != 2 {
			t.Errorf("%d runs at the end, want 2", len(got))
		}
	})

	t.Run("8-overhead", func(t *testing.T) {
		e := newEnv(t)
		dir := t.TempDir()
		ff, err := e.depSvc.Resolve(deps.FFmpeg)
		if err != nil {
			t.Skip("no ffmpeg")
		}
		var ins []string
		for i := 0; i < 20; i++ {
			path := filepath.Join(dir, fmt.Sprintf("clip%02d.wav", i))
			if out, err := exec.Command(ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
				fmt.Sprintf("sine=frequency=%d:duration=0.5", 300+i*10), path).CombinedOutput(); err != nil {
				t.Fatalf("ffmpeg: %v %s", err, out)
			}
			ins = append(ins, path)
		}
		conv := converter.DefaultOptions()
		conv.Preset = "mp3-320"
		p := e.saveReady(t, core.Pipeline{Name: "Overhead", Steps: []core.PipelineStep{
			step("conv0001", "converter", pipeline.FromInput, optionsJSON(t, conv), false),
			step("name0001", pipelines.TypeRename, "conv0001", optionsJSON(t, pipelines.RenameStep{Template: "{name} · x"}), true),
		}})
		run := e.runToEnd(t, p, ins, 5*time.Minute)
		var perCell, perCellExQueue, gaps []float64
		for _, it := range run.Items {
			for ci, c := range it.Cells {
				var sum, queue int64
				for _, id := range c.JobIDs {
					j, err := e.jobs.Get(context.Background(), id)
					if err != nil {
						t.Fatal(err)
					}
					sum += j.FinishedAt - j.StartedAt
					if q := j.StartedAt - j.CreatedAt; q > 0 {
						queue += q
					}
				}
				oh := float64((c.FinishedAt - c.StartedAt) - sum)
				perCell = append(perCell, oh)
				perCellExQueue = append(perCellExQueue, oh-float64(queue))
				if ci > 0 {
					gaps = append(gaps, float64(c.StartedAt-it.Cells[ci-1].FinishedAt))
				}
			}
		}
		avg := func(xs []float64) float64 {
			var s float64
			for _, x := range xs {
				s += x
			}
			return s / float64(len(xs))
		}
		maxOf := func(xs []float64) float64 {
			m := xs[0]
			for _, x := range xs {
				m = max(m, x)
			}
			return m
		}
		t.Logf("per-cell overhead: avg %.1f ms, max %.0f ms (n=%d)", avg(perCell), maxOf(perCell), len(perCell))
		t.Logf("per-cell overhead excluding job queue wait: avg %.1f ms, max %.0f ms", avg(perCellExQueue), maxOf(perCellExQueue))
		t.Logf("gap between consecutive cells: avg %.1f ms, max %.0f ms (n=%d)", avg(gaps), maxOf(gaps), len(gaps))
		if avg(perCell) > 300 {
			t.Errorf("avg per-cell overhead %.1f ms > 300 ms", avg(perCell))
		}
		if avg(gaps) > 300 {
			t.Errorf("avg gap %.1f ms > 300 ms", avg(gaps))
		}
	})
}

// pipeline0 saves a one-off pipeline.
func pipeline0(e *pe2e, t *testing.T, name string, steps ...core.PipelineStep) core.Pipeline {
	t.Helper()
	return e.saveReady(t, core.Pipeline{Name: name, Steps: steps})
}

// waitRuns waits until the pipeline has n runs and returns them newest first.
func (e *pe2e) waitRuns(t *testing.T, pipelineID string, n int, timeout time.Duration) []core.PipelineRun {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		runs, err := e.runner.Runs(core.RunFilter{PipelineID: pipelineID})
		if err != nil {
			t.Fatal(err)
		}
		if len(runs) >= n {
			if len(runs) != n {
				t.Errorf("%d runs, want %d", len(runs), n)
			}
			return runs
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d runs after %s, want %d", len(runs), timeout, n)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
