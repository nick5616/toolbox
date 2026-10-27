//go:build integration

// Package integration wires the real backend (store, settings, deps, jobs,
// downloader) the same way main.go does, minus Wails, and drives a real
// download. Needs network plus yt-dlp/ffmpeg/ffprobe on PATH (or in the
// managed bin dir). Run: go test -tags integration ./integration/
package integration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/store"
	"toolbox/modules/downloader"
	"toolbox/modules/placeholders"
)

type recorder struct {
	mu     sync.Mutex
	events map[string]int
}

func (r *recorder) Emit(name string, _ any) {
	r.mu.Lock()
	r.events[name]++
	r.mu.Unlock()
}

func (r *recorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.events[name]
}

func TestEndToEndDownload(t *testing.T) {
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
	settings.SetSupportDir(paths.SupportDir)

	reg := core.NewRegistry()
	depSvc := deps.New(paths.BinDir, deps.Catalog(), reg, em)
	jobs := core.NewJobs(db, db, reg, em, depSvc.Resolve, settings.Current, paths.TmpDir)
	if err := downloader.Register(reg, filepath.Join(paths.CacheDir, "yt-dlp")); err != nil {
		t.Fatal(err)
	}
	if err := placeholders.Register(reg); err != nil {
		t.Fatal(err)
	}
	if err := deps.RegisterUpdater(reg, depSvc); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer jobs.Shutdown(5 * time.Second)

	statuses := depSvc.Detect(ctx)
	for _, s := range statuses {
		t.Logf("dep %-8s %-7s %s (%s)", s.ID, s.State, s.Version, s.Source)
		if s.Required && s.State != core.DepOK {
			t.Skipf("required dependency %s is %s", s.ID, s.State)
		}
	}

	opts := downloader.DefaultOptions()
	opts.Mode = downloader.ModeVideo
	opts.MaxResolution = downloader.Res360
	opts.TrimEnabled, opts.TrimStart, opts.TrimEnd = true, "0:03", "0:09"
	raw, _ := json.Marshal(opts)

	// Bad input is rejected synchronously and creates no job.
	if _, err := jobs.Submit(ctx, downloader.ModuleID, []string{"not a url"}, string(raw)); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("invalid URL: err = %v, want validation", err)
	}

	created, err := jobs.Submit(ctx, downloader.ModuleID, []string{"https://www.youtube.com/watch?v=jNQXAC9IVRw"}, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	id := created[0].ID

	var job core.Job
	for {
		job, err = jobs.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if job.Status.Finished() {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("timed out waiting for the download")
		case <-time.After(250 * time.Millisecond):
		}
	}
	if job.Status != core.JobDone {
		logs, _ := jobs.Logs(ctx, id)
		for _, l := range logs {
			t.Logf("[%s] %s", l.Stream, l.Text)
		}
		t.Fatalf("job %s: %s (%s)", job.Status, job.Error, job.ErrorHint)
	}
	if job.Title != "Me at the zoo" {
		t.Errorf("title = %q", job.Title)
	}
	if len(job.Outputs) != 1 {
		t.Fatalf("outputs = %+v", job.Outputs)
	}
	out := job.Outputs[0]
	if out.Kind != core.KindVideo || out.SizeBytes == 0 {
		t.Errorf("output = %+v", out)
	}
	if want := filepath.Join(settings.Current().LibraryDir, "Downloads"); filepath.Dir(out.Path) != want {
		t.Errorf("output dir = %s, want %s", filepath.Dir(out.Path), want)
	}
	if _, err := os.Stat(out.Path); err != nil {
		t.Errorf("output missing on disk: %v", err)
	}
	if _, err := os.Stat(filepath.Join(paths.TmpDir, id)); !os.IsNotExist(err) {
		t.Errorf("temp dir not cleaned: %v", err)
	}

	page, err := db.ListOutputs(ctx, core.OutputQuery{ModuleID: downloader.ModuleID})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != out.ID {
		t.Fatalf("library = %+v, %v", page, err)
	}
	logs, _ := jobs.Logs(ctx, id)
	if len(logs) == 0 {
		t.Error("no logs persisted")
	}
	for _, ev := range []string{core.EventJobsChanged, core.EventJobsProgress, core.EventLibraryAdded, core.EventDepsChanged} {
		if em.count(ev) == 0 {
			t.Errorf("no %s events", ev)
		}
	}
	t.Logf("saved %s (%d bytes), %d log lines, %d progress events", out.Name, out.SizeBytes, len(logs), em.count(core.EventJobsProgress))
}

func TestEndToEndYtDlpInstall(t *testing.T) {
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
	if err := deps.RegisterUpdater(reg, depSvc); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer jobs.Shutdown(5 * time.Second)

	created, err := jobs.Submit(ctx, deps.UpdateModuleID, nil, "{}")
	if err != nil {
		t.Fatal(err)
	}
	var job core.Job
	for {
		if job, err = jobs.Get(ctx, created[0].ID); err != nil {
			t.Fatal(err)
		}
		if job.Status.Finished() {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("timed out")
		case <-time.After(250 * time.Millisecond):
		}
	}
	if job.Status != core.JobDone {
		t.Fatalf("install job %s: %s", job.Status, job.Error)
	}
	var yt core.DepStatus
	for _, s := range depSvc.List() {
		if s.ID == deps.YtDlp {
			yt = s
		}
	}
	if yt.State != core.DepOK || yt.Source != core.SourceManaged {
		t.Fatalf("yt-dlp after install = %+v", yt)
	}
	t.Logf("%s → %s (%s)", job.Message, yt.Path, yt.Version)
}
