package main

import (
	"context"
	"embed"
	"io"
	"log"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"toolbox/api"
	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/store"
	"toolbox/modules/downloader"
	"toolbox/modules/placeholders"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	paths, err := core.ResolvePaths()
	if err != nil {
		return err
	}
	if err := paths.Ensure(); err != nil {
		return err
	}
	closeLog := setupLogging(paths)
	defer closeLog()
	slog.Info("starting Toolbox", "version", core.Version, "support", paths.SupportDir)

	db, err := store.Open(paths.DBPath)
	if err != nil {
		return err
	}
	defer db.Close()

	// The Wails app is created after the services that need an emitter, so
	// emit through a late-bound adapter.
	emitter := &api.Emitter{}

	defaultLib, err := core.DefaultLibraryDir()
	if err != nil {
		return err
	}
	settings, err := core.NewSettingsService(db, emitter, defaultLib)
	if err != nil {
		return err
	}
	settings.SetSupportDir(paths.SupportDir)
	if err := os.MkdirAll(settings.Current().LibraryDir, 0o755); err != nil {
		slog.Warn("library folder unavailable", "dir", settings.Current().LibraryDir, "err", err)
	}

	reg := core.NewRegistry()
	depSvc := deps.New(paths.BinDir, deps.Catalog(), reg, emitter)
	jobs := core.NewJobs(db, db, reg, emitter, depSvc.Resolve, settings.Current, paths.TmpDir)

	if err := downloader.Register(reg, filepath.Join(paths.CacheDir, "yt-dlp")); err != nil {
		return err
	}
	if err := placeholders.Register(reg); err != nil {
		return err
	}
	if err := deps.RegisterUpdater(reg, depSvc); err != nil {
		return err
	}

	settings.OnChange(func(old, new core.Settings) {
		if old.Concurrency != new.Concurrency {
			jobs.SetConcurrency(new.Concurrency)
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		return err
	}
	go depSvc.Detect(ctx)

	opts := api.Options()
	app := application.New(application.Options{
		Name:        "Toolbox",
		Description: "Local media and utility toolbox",
		Services: []application.Service{
			application.NewServiceWithOptions(&api.ModulesService{Reg: reg}, opts),
			application.NewServiceWithOptions(&api.JobsService{Jobs: jobs}, opts),
			application.NewServiceWithOptions(&api.LibraryService{Outputs: db, Settings: settings, Paths: paths, Em: emitter}, opts),
			application.NewServiceWithOptions(&api.SettingsService{Settings: settings, Paths: paths}, opts),
			application.NewServiceWithOptions(&api.DepsService{Deps: depSvc, Jobs: jobs, Reg: reg}, opts),
			application.NewServiceWithOptions(downloader.NewService(jobs), opts),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "dev.toolbox.app",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if w := application.Get().Window.Current(); w != nil {
					w.Restore()
					w.Focus()
				}
			},
		},
	})
	emitter.App = app

	setupMenu(app, emitter)

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:          "Toolbox",
		Width:          1180,
		Height:         760,
		MinWidth:       960,
		MinHeight:      600,
		EnableFileDrop: true,
		Windows: application.WindowsWindow{
			Theme: application.Dark,
		},
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 44,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(11, 12, 14),
		URL:              startURL(),
	})
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		files := e.Context().DroppedFiles()
		emitter.Emit(core.EventFilesDropped, core.FilesDropped{Paths: files, Result: reg.Match(files)})
	})

	return app.Run()
}

// startURL honours $TOOLBOX_VIEW (dev aid: open on a given view, e.g.
// "settings" or a module ID) via the frontend's ?view= parameter.
func startURL() string {
	if v := os.Getenv("TOOLBOX_VIEW"); v != "" {
		return "/?view=" + url.QueryEscape(v)
	}
	return "/"
}

// setupLogging writes slog output to the support log file (rotated at 5 MB)
// and stderr. It returns a closer.
func setupLogging(p core.Paths) func() {
	if info, err := os.Stat(p.LogFile); err == nil && info.Size() > 5<<20 {
		_ = os.Rename(p.LogFile, p.LogFile+".1")
	}
	f, err := os.OpenFile(p.LogFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	var w io.Writer = os.Stderr
	if err == nil {
		w = io.MultiWriter(os.Stderr, f)
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo})))
	return func() {
		if f != nil {
			_ = f.Close()
		}
	}
}
