package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io"
	"log"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"toolbox/api"
	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/media"
	"toolbox/core/packs"
	"toolbox/core/pdfium"
	"toolbox/core/sidecar"
	"toolbox/core/store"
	"toolbox/core/viz"
	"toolbox/desktop"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/chat"
	"toolbox/modules/clipboard"
	"toolbox/modules/converter"
	"toolbox/modules/devutils"
	"toolbox/modules/downloader"
	"toolbox/modules/eraser"
	"toolbox/modules/exif"
	"toolbox/modules/lyricvideo"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/pdf"
	"toolbox/modules/placeholders"
	"toolbox/modules/redact"
	"toolbox/modules/stems"
	"toolbox/modules/subtitles"
	"toolbox/modules/transcribe"
	"toolbox/modules/trimmer"
	"toolbox/modules/upscale"
	"toolbox/modules/vault"
	"toolbox/modules/visualizer"
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

	// Audio engine: a virtual dependency plus a lazily started sidecar.
	engine := sidecar.NewManager(paths, func() (string, error) { return depSvc.Resolve(sidecar.DepID) }, emitter)
	defer engine.Stop()
	depSvc.RegisterVirtual(deps.Spec{
		ID: sidecar.DepID, Name: "AI engine", Managed: true,
		Purpose:     "Python runtime for stems, BPM & key, MIDI, transcription and background removal (≈1.4 GB)",
		InstallHint: map[string]string{"darwin": "Install from Settings → Dependencies", "windows": "Install from Settings → Dependencies", "linux": "Install from Settings → Dependencies"},
	}, func(ctx context.Context) core.DepStatus { return sidecar.Detect(ctx, paths) })

	exifMod := exif.New(depSvc.Resolve)
	defer exifMod.Close()
	pdfRenderer := pdfium.New(filepath.Join(paths.CacheDir, "pdfium"))
	defer pdfRenderer.Close()
	pdfMod := pdf.New(pdfRenderer)
	clipHistory := clipboard.New(clipboard.Config{Store: db, Settings: settings, Emitter: emitter, Dir: paths.ClipboardDir})
	defer clipHistory.Stop()
	libraryDir := func() string { return settings.Current().LibraryDir }

	// --- Local Chat (CH1 may edit this block) ---
	chatSvc := chat.New(chat.Config{
		Store: db, Settings: settings, Jobs: jobs, Emitter: emitter,
		ModelsDir: paths.ModelsDir, TmpDir: paths.TmpDir, Resolve: depSvc.Resolve, LibraryDir: libraryDir,
		RegisterOutput: func(path string) error { // exported chats appear in the library
			o, err := core.NewOutput(path, "", chat.ModuleID)
			if err != nil {
				return err
			}
			if o, err = db.UpsertOutput(context.Background(), o); err != nil {
				return err
			}
			emitter.Emit(core.EventLibraryAdded, o)
			return nil
		},
	})
	defer chatSvc.Stop()
	// --- end Local Chat ---

	// --- Vault (VA1 may edit this block) ---
	vaultSvc := vault.New(vault.Config{
		LibraryDir: libraryDir, OpenDir: filepath.Join(paths.TmpDir, "vault-open"),
		Settings: settings, Jobs: jobs, Emitter: emitter,
		OpenFile: func(path string) error { return application.Get().Browser.OpenFile(path) },
	})
	defer vaultSvc.Close()
	vaultAPI := vault.NewService(vaultSvc)
	// --- end Vault ---

	// --- Tool packs (PK1 may edit this block) ---
	packSvc := packs.New(packs.Config{
		Paths: paths, Reg: reg, Deps: depSvc, Jobs: jobs, Settings: settings, Emitter: emitter,
		StopEngines: func() { engine.Stop(); chatSvc.Stop() },
	})
	pendingPacks := packSvc.StartupTasks()
	// The engine finds ffmpeg (pydub) first on its PATH: managed copy, else system.
	engine.SetFFmpegResolver(func() (string, error) { return depSvc.Resolve(deps.FFmpeg) })
	// --- end Tool packs ---

	// --- Phase 6 tools (architect) ---
	mediaAPI := &api.MediaService{Paths: paths, Jobs: jobs, Resolve: depSvc.Resolve, GOOS: runtime.GOOS}
	subtitlesMod, err := subtitles.Register(reg, engine, chatSvc, depSvc.Resolve, paths.ModelsDir)
	if err != nil {
		return err
	}
	cleanupMod, err := audiocleanup.Register(reg, engine, depSvc.Resolve, paths.ModelsDir, filepath.Join(paths.CacheDir, "cleanup-preview"))
	if err != nil {
		return err
	}
	lyricMod, err := lyricvideo.Register(reg, engine, depSvc.Resolve, paths.ModelsDir, filepath.Join(paths.CacheDir, "lyric-video"))
	if err != nil {
		return err
	}
	redactMod, err := redact.Register(reg, engine, depSvc.Resolve, paths.ModelsDir, filepath.Join(paths.CacheDir, "redact"))
	if err != nil {
		return err
	}
	eraserMod, err := eraser.Register(reg, engine, paths.ModelsDir, filepath.Join(paths.TmpDir, "eraser"))
	if err != nil {
		return err
	}
	if _, err := media.RegisterProxy(reg, media.CacheDir(paths)); err != nil {
		return err
	}
	// --- Phase 7 Visualizer (architect) ---
	vizLabDir := ""
	if os.Getenv("TOOLBOX_VIZLAB") == "1" {
		vizLabDir = filepath.Join(paths.TmpDir, "vizlab")
	}
	vizAnalyzer := viz.NewAnalyzer(filepath.Join(paths.CacheDir, "visualizer"), paths.ModelsDir, engine, chatSvc)
	vizBroker := viz.NewRenderBroker(emitter, mediaAPI.URLFor, vizLabDir)
	vizBroker.SetAppOrigins("http://wails.localhost", "wails://wails")
	visualizerMod, err := visualizer.Register(reg, vizAnalyzer, vizBroker, engine, chatSvc, depSvc.Resolve,
		paths.ModelsDir, filepath.Join(paths.CacheDir, "visualizer"))
	if err != nil {
		return err
	}
	lyricMod.SetVisuals(vizAnalyzer, vizBroker)
	subtitlesMod.SetVisuals(vizAnalyzer, vizBroker)
	// --- end Phase 7 ---
	go func() { // start-up cleanup of Phase 6 caches (SPEC.md §3.9)
		eraserMod.ClearMasks()
		cleanupMod.PrunePreviews()
		lyricMod.PruneCache()
		redactMod.PruneCache()
		media.PruneCache(media.CacheDir(paths), media.CacheLimitBytes)
		vizAnalyzer.Prune()
		visualizerMod.PrunePreviews()
	}()
	// --- end Phase 6 tools ---

	for _, register := range []func() error{
		func() error { return downloader.Register(reg, filepath.Join(paths.CacheDir, "yt-dlp")) },
		func() error { return stems.Register(reg, engine) },
		func() error { return bpmkey.Register(reg, engine) },
		func() error { return midi.Register(reg, engine) },
		func() error { return converter.Register(reg) },
		func() error { return transcribe.Register(reg, engine, paths.ModelsDir) },
		func() error { return exif.Register(reg, exifMod) },
		func() error { return clipboard.Register(reg) },
		func() error { return bgremove.Register(reg, engine, paths.ModelsDir) },
		func() error { return upscale.Register(reg, engine, paths.ModelsDir) },
		func() error { return pdf.Register(reg, pdfMod) },
		func() error { return chat.Register(reg, chatSvc) },
		func() error { return vault.Register(reg, vaultSvc) },
		func() error { return ocr.Register(reg, engine, pdfRenderer, paths.ModelsDir) },
		func() error { return packs.Register(reg, packSvc) },
		func() error { return trimmer.Register(reg, depSvc.Resolve) },
		func() error { return devutils.Register(reg) },
		func() error { return placeholders.Register(reg) },
		func() error { return deps.RegisterExifToolUpdater(reg, depSvc) },
		func() error { return deps.RegisterUpscalerInstaller(reg, depSvc) },
		func() error { return deps.RegisterLlamaInstaller(reg, depSvc) },
		func() error { return deps.RegisterFFmpegInstaller(reg, depSvc) },
		func() error { return deps.RegisterDenoInstaller(reg, depSvc) },
		func() error { return deps.RegisterUpdater(reg, depSvc) },
		func() error { return deps.RegisterUVUpdater(reg, depSvc) },
		func() error {
			return sidecar.RegisterSetup(reg, paths, engine,
				func() (string, error) { return depSvc.Resolve(deps.UV) },
				func(ctx context.Context, job *core.JobContext) error {
					return depSvc.InstallManagedBinary(ctx, job, deps.UVBinary())
				},
				func(ctx context.Context) { depSvc.Detect(ctx) })
		},
	} {
		if err := register(); err != nil {
			return err
		}
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
	clipHistory.Start(ctx)
	vaultSvc.Start(ctx)
	if len(pendingPacks) > 0 { // a relaunch for a new tools folder: continue the install
		if _, err := packSvc.Install(pendingPacks, ""); err != nil {
			slog.Warn("pending pack install", "err", err)
		}
	}

	desktopSvc := &api.DesktopService{} // Shell is set once the app exists
	packsAPI := &api.PacksService{Packs: packSvc}
	opts := api.Options()
	app := application.New(application.Options{
		Name:        "Toolbox",
		Description: "Local media and utility toolbox",
		Services: []application.Service{
			application.NewServiceWithOptions(&api.ModulesService{Reg: reg}, opts),
			application.NewServiceWithOptions(&api.JobsService{Jobs: jobs}, opts),
			application.NewServiceWithOptions(&api.LibraryService{Outputs: db, Settings: settings, Paths: paths, Em: emitter}, opts),
			application.NewServiceWithOptions(&api.SettingsService{Settings: settings, Paths: paths}, opts),
			application.NewServiceWithOptions(&api.DepsService{Deps: depSvc, Jobs: jobs, Reg: reg, Engine: engine, Paths: paths, StopExiftool: exifMod.Close}, opts),
			application.NewServiceWithOptions(&api.FilesService{Reg: reg, Settings: settings, Paths: paths}, opts),
			application.NewServiceWithOptions(desktopSvc, opts),
			application.NewServiceWithOptions(downloader.NewService(jobs), opts),
			application.NewServiceWithOptions(stems.NewService(jobs), opts),
			application.NewServiceWithOptions(bpmkey.NewService(jobs), opts),
			application.NewServiceWithOptions(midi.NewService(jobs), opts),
			application.NewServiceWithOptions(converter.NewService(jobs), opts),
			application.NewServiceWithOptions(transcribe.NewService(jobs), opts),
			application.NewServiceWithOptions(exif.NewService(jobs, exifMod), opts),
			application.NewServiceWithOptions(clipboard.NewService(clipHistory), opts),
			application.NewServiceWithOptions(bgremove.NewService(jobs), opts),
			application.NewServiceWithOptions(upscale.NewService(jobs), opts),
			application.NewServiceWithOptions(pdf.NewService(jobs, pdfMod), opts),
			application.NewServiceWithOptions(chat.NewService(chatSvc), opts),
			application.NewServiceWithOptions(ocr.NewService(jobs), opts),
			application.NewServiceWithOptions(vaultAPI, opts),
			application.NewServiceWithOptions(packsAPI, opts),
			application.NewServiceWithOptions(mediaAPI, opts),
			application.NewServiceWithOptions(trimmer.NewService(jobs), opts),
			application.NewServiceWithOptions(subtitles.NewService(jobs, subtitlesMod), opts),
			application.NewServiceWithOptions(audiocleanup.NewService(jobs, cleanupMod), opts),
			application.NewServiceWithOptions(lyricvideo.NewService(jobs), opts),
			application.NewServiceWithOptions(redact.NewService(jobs), opts),
			application.NewServiceWithOptions(eraser.NewService(jobs, eraserMod), opts),
			application.NewServiceWithOptions(devutils.NewService(jobs), opts),
			application.NewServiceWithOptions(visualizer.NewService(jobs, visualizerMod), opts),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
			// Local media for the players, in-process: no socket (SPEC.md §3.2).
			Middleware: api.MediaMiddleware(mediaAPI),
		},
		// The app lives in the tray: closing windows never quits by itself;
		// the desktop shell decides (KeepInTray) and quits explicitly.
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Windows: application.WindowsOptions{DisableQuitOnLastWindowClosed: true, WebviewUserDataPath: sandboxWebviewDir(paths)},
		// The Visualizer streams rendered video over raw messages: no socket
		// (SPEC.md §4.4). The broker checks the token and the origin.
		RawMessageHandler: func(_ application.Window, msg string, origin *application.OriginInfo) {
			if origin != nil {
				vizBroker.HandleRawMessage(msg, origin.Origin, origin.TopOrigin)
			}
		},
		Linux: application.LinuxOptions{DisableQuitOnLastWindowClosed: true},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: instanceID(paths),
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if w := application.Get().Window.Current(); w != nil {
					w.Restore()
					w.Focus()
				}
			},
		},
	})
	emitter.App = app
	packsAPI.RelaunchFn = func() error { return desktop.Relaunch(app.Quit) }
	api.ObservePacks(app, packsAPI)

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
	// Keep the native title bar in step with the app theme (Windows).
	applyTitleBar := func() {
		t := settings.Current().Theme
		dark := t == core.ThemeDark || (t == core.ThemeSystem && app.Env.IsDarkMode())
		application.InvokeSync(func() { setTitleBarDark(win, dark) })
	}
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) { applyTitleBar() })
	app.Event.OnApplicationEvent(events.Common.ThemeChanged, func(*application.ApplicationEvent) { applyTitleBar() })
	settings.OnChange(func(old, new core.Settings) {
		if old.Theme != new.Theme {
			applyTitleBar()
		}
	})

	// --- desktop shell (WP-D1): tray, close-to-tray, login item, hotkeys, popup ---
	shell := desktop.New(desktop.Options{
		App: app, Main: win, Settings: settings, Jobs: jobs, Outputs: db, Emitter: emitter,
		Clipboard: clipHistory, Vault: vaultAPI,
		DarkMode: func() bool {
			t := settings.Current().Theme
			return t == core.ThemeDark || (t == core.ThemeSystem && app.Env.IsDarkMode())
		},
	})
	if err := shell.Start(); err != nil {
		return err
	}
	desktopSvc.Shell = shell
	clipHistory.SetPopupOpener(shell.TogglePopup)
	if os.Getenv("TOOLBOX_SHOW_POPUP") != "" { // dev aid for visual QA (no hotkey needed)
		app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
			go func() {
				time.Sleep(2 * time.Second)
				_ = shell.TogglePopup()
			}()
		})
	}
	// --- end desktop shell ---

	win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		files := e.Context().DroppedFiles()
		drop := core.FilesDropped{Paths: files, Result: reg.Match(files)}
		if d := e.Context().DropTargetDetails(); d != nil {
			drop.TargetID = d.ElementID
		}
		emitter.Emit(core.EventFilesDropped, drop)
	})

	return app.Run()
}

// instanceID is the single-instance lock name. A sandbox support dir
// ($TOOLBOX_SUPPORT_DIR) gets its own lock, so a sandbox instance can run
// next to the real app instead of focusing it.
func instanceID(p core.Paths) string {
	if os.Getenv(core.EnvSupportDir) == "" {
		return "dev.toolbox.app"
	}
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(p.SupportDir))))
	return "dev.toolbox.app." + hex.EncodeToString(sum[:6])
}

// startURL honours $TOOLBOX_VIEW (dev aid: open on a given view, e.g.
// "settings" or a module ID) via the frontend's ?view= parameter.
// sandboxWebviewDir keeps WebView2's profile inside a sandbox support dir
// (TOOLBOX_SUPPORT_DIR) so dev and test runs never share or create profiles
// in %APPDATA%. "" = Wails' default for the real app.
func sandboxWebviewDir(p core.Paths) string {
	if os.Getenv(core.EnvSupportDir) == "" {
		return ""
	}
	return filepath.Join(p.SupportDir, "webview2")
}

func startURL() string {
	if os.Getenv("TOOLBOX_VIZLAB") == "1" && os.Getenv("TOOLBOX_VIEW") == "vizlab" { // dev-only lab (SPEC.md §11.4)
		q := "/?window=vizlab"
		if k := os.Getenv("TOOLBOX_VIZLAB_KEY"); k != "" {
			q += "&key=" + url.QueryEscape(k)
		}
		if p := os.Getenv("TOOLBOX_VIZLAB_ONLY"); p != "" {
			q += "&only=" + url.QueryEscape(p)
		}
		if l := os.Getenv("TOOLBOX_VIZLAB_LAYER"); l != "" {
			q += "&layer=" + url.QueryEscape(l)
		}
		if extra, err := url.ParseQuery(os.Getenv("TOOLBOX_VIZLAB_ARGS")); err == nil && len(extra) > 0 {
			q += "&" + extra.Encode() // more lab modes, e.g. "text=karaoke"
		}
		return q
	}
	q := url.Values{}
	if v := os.Getenv("TOOLBOX_VIEW"); v != "" {
		q.Set("view", v)
	}
	if os.Getenv("TOOLBOX_VIZ_FORCE_JPEG") == "1" { // test the renderer's JPEG path (Mac checklist)
		q.Set("vizjpeg", "1")
	}
	if os.Getenv("TOOLBOX_VIZ_FIXTURE") == "1" { // dev: the Visualizer uses the synthetic analysis
		q.Set("vizfixture", "1")
	}
	if len(q) == 0 {
		return "/"
	}
	return "/?" + q.Encode()
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
