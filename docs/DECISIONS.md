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
