# Decisions

Newest last. Format: date — decision — why.

## Made in SPEC.md (Phase 1, approved 2026-10-27)

- 2026-10-27 — Pin Wails **v3.0.0** (stable, released 2026-10-26) and `@wailsio/runtime 3.0.0`. — First stable v3; nightlies are v3.1.
- 2026-10-27 — Module contract: `Descriptor` value + `Validate` + `Run(ctx, *JobContext)`; options as `json.RawMessage` decoded by the module; one typed Wails service per module for submission. — Serializable metadata for the UI, fail-fast validation, and no `any` across the TS boundary.
- 2026-10-27 — `core` never imports Wails; `api/` adapts. — Keeps the core unit-testable.
- 2026-10-27 — SQLite via `modernc.org/sqlite` v1.61.0, single connection, WAL; in-house embedded migrator. — Pure Go (no CGO), no extra migration dependency.
- 2026-10-27 — Job IDs and output IDs are ULIDs (`oklog/ulid/v2` v2.1.2). — Time-sortable, maintained.
- 2026-10-27 — Retry keeps the same job ID (attempt++). — One row per logical task in the tray.
- 2026-10-27 — Only yt-dlp is app-managed (downloaded from GitHub releases with SHA-256 verification); ffmpeg/ffprobe/deno/node/exiftool are detected with install hints. — Scope; yt-dlp changes fastest.
- 2026-10-27 — Dependency resolution checks well-known dirs (Homebrew etc.) after PATH. — GUI apps launched from Finder don't inherit the shell PATH.
- 2026-10-27 — yt-dlp gets an explicit `--js-runtimes` (deno, else node). — Full YouTube support now requires a JS runtime; only deno is enabled by default.
- 2026-10-27 — Command palette built in-house instead of `cmdk`. — `cmdk` has had no release for over a year.
- 2026-10-27 — CSS Modules + design tokens; Geist / Geist Mono bundled via fontsource. — No component-library look; no network fonts.
- 2026-10-27 — `wails3 dev` runs Vite on `127.0.0.1:9245`. — Accepted dev-only exception to "no listeners"; the production binary serves assets through the webview scheme and opens no ports (verified: no LISTEN sockets on the built app).
- 2026-10-27 — Never build with `-tags server` or `-tags mcp`; removed the template's server/docker tasks. — Those are the only Wails code paths that open listeners.
- 2026-10-27 — Playlist toggle (default off) included in the downloader. — Cheap with the progress template; common need.

## Made during the build

- 2026-10-27 — Node 24 installed per-user via **fnm** instead of upgrading the global Node 20 with winget. — The global Node is a machine-wide MSI install (needs admin/UAC, which the no-sudo rule forbids) and other repos depend on it. This was the alternative the spec offered.
- 2026-10-27 — Go 1.27.3 installed from the official zip (checksum-verified) into `%LOCALAPPDATA%\Programs\go1.27.3` instead of `winget install GoLang.Go`. — The winget package has no per-user installer; machine-wide install needs elevation.
- 2026-10-27 — Bindings generated as TS **interfaces** (`-ts -i`), the template default, rather than classes. — Plain data objects; no class instances to construct when calling services.
- 2026-10-27 — Event names in `api/events.go` are string literals (mirroring `core/events.go` constants). — The binding generator's static analysis documents only direct constant arguments; literals are the safe form.
- 2026-10-27 — `downloader.Register(reg, cacheDir)` drops the `resolve` parameter from the spec. — Tools are resolved through `JobContext.Tool`, so the module doesn't need its own resolver.
- 2026-10-27 — `frontend/dist/.gitkeep` is committed (and re-copied by Vite from `public/`). — `//go:embed all:frontend/dist` must match a file for `go build ./...` to work in fresh worktrees.
- 2026-10-27 — Removed the template's `frontend/.npmrc` (`minimum-release-age`). — npm 11 warns on every command because it doesn't support the key.
- 2026-10-27 — No native application menu on Windows. — Standard frame without a menu bar matches the spec's "native frame"; Ctrl+, etc. are handled in the frontend.
- 2026-10-27 — Builders run as `general-purpose` agents pinned to Sonnet with worktree isolation, with the rules of `.claude/agents/builder.md` pasted into each brief. — The architect session was started from the home directory, so the repo's `builder` agent type wasn't loaded. Behaviour is equivalent.
- 2026-10-27 — No `go test -race` on the Windows dev box; concurrency suites run with `-count=20` instead. — `-race` needs cgo and there is no C toolchain here (installing one needs admin). Run `go test -race ./...` on the Mac.
- 2026-10-27 — Light-theme accent darkened from `#DD6416` to `#BD5310` (accent-soft to match). — White button text on the spec value was 3.55:1; the new value is 4.76:1 (AA) and also raises accent-on-panel contrast to 4.45:1. Contrast test now enforces AA for `--accent-fg` on `--accent`.
- 2026-10-27 — `shell/JobRow.tsx` stub with frozen props added before Wave 2. — The downloader view (WP-G) reuses the tray row component built in parallel by WP-F.
- 2026-10-27 — `DefaultTheme` is a `var`, not a const. — Typed consts are emitted into the TS enum by the binding generator; it showed up as a duplicate `Theme` member.
- 2026-10-27 — A job that succeeds keeps its module's last progress message (spec said clear it). — Lets "Already up to date (2026.10.26)" / "Done" stay visible in the tray.
- 2026-10-27 — Backend end-to-end tests live in `integration/` behind the `integration` build tag (real yt-dlp download through store+settings+deps+jobs, and a real yt-dlp install from GitHub). — Not part of default `go test ./...` because they need network.
- 2026-10-27 — Windows window uses the dark native title bar (`WindowsWindow.Theme = Dark`). — Matches the default dark UI. Known gap: it stays dark when the app theme is Light.
- 2026-10-27 — Downloader strips yt-dlp's Python `(caused by …)` suffix from error messages and hints "Check that the link is correct…" for HTTP 404 / unreachable pages. — Found during smoke testing; raw messages were noisy.
- 2026-10-27 — Settings → Dependencies shows each tool's path under its name instead of in a separate column; the table uses fixed column widths. — The six-column table overflowed the 720px layout and caused horizontal scrolling.
- 2026-10-27 — `TOOLBOX_VIEW` env var opens the app on a given view (dev aid, used for visual QA). — No UI automation is available without opening a debug port; screenshots were taken with passive window capture.

## Phase 2 (approved 2026-10-27)

### Made in SPEC.md
- 2026-10-27 — Audio engine = one uv-managed CPython **3.12** sidecar over stdio JSON Lines; installed on demand (~1 GB) into the support dir. — 3.13 imported 10× slower in testing; no network listeners; explicit opt-in for the large download.
- 2026-10-27 — audio-separator 0.47.1 `[cpu]` everywhere (MPS/CoreML on Apple Silicon per upstream docs); basic-pitch 0.4.0 via its bundled ONNX model with uv `exclude-dependencies` (TF/coremltools) and `override-dependencies` (`resampy>=0.4.3`). — basic-pitch's TF pin can't install on 3.12; the ONNX path works unpatched.
- 2026-10-27 — uv is the second app-managed binary (same verified-download flow as yt-dlp, generalised as `InstallManagedBinary`).
- 2026-10-27 — Engine recycled after any result with `rssBytes` > 3 GiB; idle stop after 10 min; hard kill + restart if a cancel isn't honoured within 3 s. — MDX separation memory grew 2.9 → 3.9 GB and wasn't released.

### Made during the build
- 2026-10-27 — Job results (`Job.ResultJSON`, migration 0002) instead of a results table. — Results belong to the job; one nullable column keeps the schema simple; verified upgrading a real Phase 1 database.
- 2026-10-27 — `core.UniquePath`/`StemName` added to core for collision-free outputs. — Converter and MIDI both needed it.
- 2026-10-27 — The sidecar's selftest reports `packages["toolbox-sidecar"]`. — The Go setup step reads it for the engine version string.
- 2026-10-27 — **Sidecar protocol uses private dups of stdin/stdout; fd 0 → NUL, fd 1 → stderr.** — Found by the end-to-end test: on Windows a synchronous read pending on the stdin pipe stalled first-run numba/librosa work (a job hung 18 min; isolated repro: 96 s blocked vs 6 s). Also keeps child processes from writing into the protocol.
- 2026-10-27 — `proc` caps lines at 1 MiB, so engine replies ≥ 1 MiB fail that call (spec said 16 MiB). — Results are kilobytes; raising the cap wasn't worth the memory risk.
- 2026-10-27 — Shared tool-view helpers (`submitJobs`, `FileActions`, `runLabel`, result styles) live in `tools/_kit`. — The views builder had put them under `tools/stems/shared`; moved at integration.
- 2026-10-27 — BPM & Key "Copy CSV" uses the table's columns (`File,BPM,Key,Camelot,Confidence,Analyzed`). — Spec listed five lowercase columns; the kit builds CSV from visible columns.
- 2026-10-27 — Converter select labels are prefixed ("Audio · MP3 · 320 kbps") instead of `<optgroup>`s. — The Select component has no group support; not worth extending for one view.
- 2026-10-27 — Converter submits only compatible inputs when some don't fit the preset (others stay flagged). — Avoids failing a whole batch over one wrong file.
- 2026-10-27 — Downloader options now use the kit's `useModuleOptions` with static defaults mirroring Go's `DefaultOptions()`. — The hook needs defaults synchronously.
- 2026-10-27 — Stems reports a "Preparing" stage before importing torch/audio-separator. — Without it the first seconds of a job showed no message.
- 2026-10-27 — Windows title bar follows the app theme via `DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE)` on `NativeWindow()`; updated on startup, settings change and OS theme change. — Wails v3 has no runtime setter.

## Phase 3 (approved 2026-10-27)

### Made in SPEC.md
- 2026-10-27 — Clipboard history via `golang.design/x/clipboard` v0.11.0 (Wails' clipboard API is text-only with no change events); opt-in, sensitive copies skipped, no auto-paste.
- 2026-10-27 — Transcription runs in the existing audio engine with faster-whisper 1.2.1 (CTranslate2, CPU int8); default model `small`; PyAV pinned `<19`. Engine 0.3.0 (+≈157 MB) → existing installs show Update.
- 2026-10-27 — ExifTool becomes the third app-managed tool, installed as an archive (`InstallManagedArchive`) from SourceForge with exiftool.org checksums; macOS runs the Perl distribution with the system perl.

### Made during the build
- 2026-10-27 — `ClipStore` gained `TouchClip(id, at)` (not in the spec). — Re-copying an item needs to bump `last_used_at` without re-hashing content.
- 2026-10-27 — `SettingsPatch.Hotkeys` merges entries into the current map instead of replacing it. — Lets the UI change one shortcut without resending the others; unknown actions are still rejected.
- 2026-10-27 — Accelerator validation lives in core (`CanonicalAccelerator`): Wails syntax, at least one of CmdOrCtrl/Ctrl/Alt/Super, duplicates compared case- and alias-insensitively. — Rejects shortcuts that would swallow normal typing before the OS is asked.
- 2026-10-27 — Windows/Linux `DisableQuitOnLastWindowClosed` and macOS `ApplicationShouldTerminateAfterLastWindowClosed: false`; the desktop shell quits explicitly. — Needed for close-to-tray and the hidden popup window.
- 2026-10-27 — `MetadataView` carries `sizeBytes`, `make`, `model`, `dateTaken` and current editable `fields` in addition to the spec's fields. — The inspector header and the edit dialog need them; avoids a second call.
- 2026-10-27 — The first-hide-to-tray toast waits until the window is visible again. — The window is hidden when the event arrives.
- 2026-10-27 — Builders run with reduced test parallelism (`go test -p 2`, `vitest --maxWorkers=2`). — The dev machine had < 4 GB free RAM with six worktrees building at once.
