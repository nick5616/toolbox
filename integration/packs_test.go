//go:build integration

package integration

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/packs"
	"toolbox/core/sidecar"
	"toolbox/core/store"
	"toolbox/modules/bgremove"
	"toolbox/modules/converter"
	"toolbox/modules/downloader"
	"toolbox/modules/exif"
	"toolbox/modules/upscale"
)

// TestPackInstall installs the Media pack (and, with TOOLBOX_PACKS_FULL=1,
// the Image pack: AI engine + background model + upscaler + ExifTool, about
// 1.7 GB) through the real pack job, the way the setup screen does, then
// checks the pack reports installed and the disk use matches the catalog
// within ±10% (SPEC.md §12.4).
func TestPackInstall(t *testing.T) {
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
	engine.SetFFmpegResolver(func() (string, error) { return depSvc.Resolve(deps.FFmpeg) })
	depSvc.RegisterVirtual(deps.Spec{ID: sidecar.DepID, Name: "AI engine", Managed: true},
		func(ctx context.Context) core.DepStatus { return sidecar.Detect(ctx, paths) })
	packSvc := packs.New(packs.Config{Paths: paths, Reg: reg, Deps: depSvc, Jobs: jobs, Settings: settings, Emitter: em})
	exifMod := exif.New(depSvc.Resolve)
	defer exifMod.Close()
	for _, err := range []error{
		downloader.Register(reg, filepath.Join(paths.CacheDir, "yt-dlp")), converter.Register(reg),
		exif.Register(reg, exifMod),
		bgremove.Register(reg, engine, paths.ModelsDir), upscale.Register(reg, engine, paths.ModelsDir),
		deps.RegisterUpdater(reg, depSvc), deps.RegisterExifToolUpdater(reg, depSvc),
		deps.RegisterUpscalerInstaller(reg, depSvc), deps.RegisterFFmpegInstaller(reg, depSvc),
		deps.RegisterDenoInstaller(reg, depSvc), deps.RegisterUVUpdater(reg, depSvc),
		sidecar.RegisterSetup(reg, paths, engine,
			func() (string, error) { return depSvc.Resolve(deps.UV) },
			func(ctx context.Context, job *core.JobContext) error {
				return depSvc.InstallManagedBinary(ctx, job, deps.UVBinary())
			},
			func(ctx context.Context) { depSvc.Detect(ctx) }),
		packs.Register(reg, packSvc),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer jobs.Shutdown(10 * time.Second)
	depSvc.Detect(ctx)

	ids := []string{"media"}
	if os.Getenv("TOOLBOX_PACKS_FULL") != "" {
		ids = append(ids, "image")
	}
	before := statusOf(packSvc.List())
	res, err := packSvc.Install(ids, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Jobs) != len(ids) || res.Restart {
		t.Fatalf("install result = %+v", res)
	}
	start := time.Now()
	for _, j := range res.Jobs {
		waitJob(t, ctx, jobs, j.ID)
	}
	t.Logf("installed %v in %s", ids, time.Since(start).Round(time.Second))
	depSvc.Detect(ctx)

	after := statusOf(packSvc.List())
	for _, id := range ids {
		p := after[id]
		if p.State != core.PackInstalled {
			t.Errorf("%s: state %s after install", id, p.State)
		}
		// Expected disk use: the catalog size of every component this run
		// installed (missing before, not a system copy).
		var want int64
		for _, c := range before[id].Components {
			if c.State == core.ComponentMissing {
				want += c.DiskBytes
			}
		}
		t.Logf("%s: catalog %d bytes for the components it installed", id, want)
		for _, c := range p.Components {
			t.Logf("  %-16s %s", c.ID, c.State)
		}
	}
	got := dirSize(t, paths.BinDir) + dirSize(t, paths.ModelsDir) + dirSize(t, paths.SidecarDir) + dirSize(t, paths.PythonDir)
	var want int64
	seen := map[string]bool{}
	for _, id := range ids {
		for _, c := range before[id].Components {
			if c.State == core.ComponentMissing && !seen[c.ID] {
				seen[c.ID] = true
				want += c.DiskBytes
			}
		}
	}
	t.Logf("measured %d bytes on disk, catalog %d (%+.1f%%)", got, want, 100*float64(got-want)/float64(max(want, 1)))
	if want > 0 && (float64(got) < 0.9*float64(want) || float64(got) > 1.1*float64(want)) {
		t.Errorf("disk use %d is more than 10%% off the catalog's %d", got, want)
	}
}

func statusOf(list []core.PackStatus) map[string]core.PackStatus {
	m := map[string]core.PackStatus{}
	for _, p := range list {
		m[p.ID] = p
	}
	return m
}

func dirSize(t *testing.T, dir string) int64 {
	t.Helper()
	var n int64
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(p, ".part") {
			return nil
		}
		if info, err := d.Info(); err == nil {
			n += info.Size()
		}
		return nil
	})
	return n
}
