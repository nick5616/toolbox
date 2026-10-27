# Toolbox — Phase 1 Spec

Status: **DRAFT, awaiting review.** Once the owner says "approved", this file is binding.
Date: 2026-10-27. Author: architect session (Opus).

---

## 0. Research findings this spec relies on

Verified on 2026-10-27 against primary sources (GitHub API, module proxy, npm registry, Wails source at tag `v3.0.0`).

| Topic | Finding | Consequence |
|---|---|---|
| Wails v3 status | **v3.0.0 stable was released 2026-10-26** (the beta ran from Aug 2026 through beta.34). The v3.1 line is nightly only. | Pin `github.com/wailsapp/wails/v3 v3.0.0` and `@wailsio/runtime 3.0.0`. Don't use nightlies. |
| Wails toolchain | Requires **Go ≥ 1.26** (recommends 1.26.10+ or 1.27.3+). Install with `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0`. `wails3 setup` is an interactive TUI wizard; `wails3 doctor` checks the environment non-interactively. | Builders and the architect use `wails3 doctor`, never `wails3 setup`. |
| Templates | Built-in templates are `vanilla`, `react`, `vue` and `svelte` (TypeScript), plus `-js` variants. The `react` template ships React 18, Vite 8 and `@wailsio/runtime/plugins/vite`. Its tsconfig sets `noImplicitAny: false`. | Scaffold with `-t react`, then upgrade to React 19 and tighten the tsconfig. |
| Bindings | `wails3 generate bindings -ts` uses static analysis. Go structs become TS classes, and Go typed-string consts become TS enums. Doc comments carry through. The output goes to `frontend/bindings/<go module path>/<pkg>/`. A bound method whose first parameter is `context.Context` is **cancellable from JS** through `CancellablePromise.cancel()`. | Go module path is `toolbox`, so bindings land at `frontend/bindings/toolbox/...`. |
| Typed events | `application.RegisterEvent[T](name)` called from `init()` produces typed TS event data. `app.Event.Emit(name, data)` is checked against the registered type at runtime. | All app events are registered this way. Untyped events are not allowed. |
| Service errors | `ServiceOptions.MarshalError func(error) []byte`. The JS promise rejects with a `RuntimeError` whose `cause` holds the marshalled JSON. | Structured `AppError` crosses the boundary as JSON. |
| Services lifecycle | Optional `ServiceStartup(ctx, ServiceOptions) error` and `ServiceShutdown() error`. | The jobs manager shuts down cleanly through `ServiceShutdown`. |
| File drop | Window option `EnableFileDrop: true`. Any element with the `data-file-drop-target` attribute becomes a target, and Wails toggles the class `file-drop-target-active` on it during a drag. Go receives `events.Common.WindowFilesDropped` and gets absolute paths from `event.Context().DroppedFiles()`. | The global drop overlay is built on this. |
| Native APIs | `app.Env.OpenFileManager(path, selectFile)` (reveal), `app.Browser.OpenFile(path)` (open with the default app), `app.Dialog.OpenFileWithOptions{CanChooseDirectories}`, `app.GlobalShortcut.Register(accel, fn)`, built-in system tray and multi-window, `application.SingleInstanceOptions`, and menu roles (`AppMenu`, `EditMenu`, `WindowMenu`…). | Global hotkeys, tray and multi-window are first-class later. Nothing in Phase 1 needs extra libraries. |
| Listeners | In `pkg/application`, the only files that open network listeners are `application_server.go` (`//go:build server`) and `mcp_enabled.go` (`//go:build mcp`). Single-instance support uses OS IPC, not sockets. Production assets are served through the webview's custom scheme, not a TCP port. | **Never build with `-tags server` or `-tags mcp`.** The production app opens no ports. `wails3 dev` runs Vite on `127.0.0.1:9245`, which is a dev-only exception (§4.8). |
| macOS translucency | Translucent backdrops need the `private_mac_apis` build tag. | Not used. Opaque window, our own colours. |
| SQLite | `modernc.org/sqlite` **v1.61.0** (2026-10-21), pure Go, actively maintained. | Use it. Driver name `"sqlite"`. |
| IDs | `github.com/oklog/ulid/v2` **v2.1.2** (2026-07-23), maintained. | ULIDs for jobs and outputs, which sort by time. |
| yt-dlp | Latest is **2026.10.26**. Standalone assets include `yt-dlp_macos` (universal), `yt-dlp.exe`, `yt-dlp_arm64.exe`, `yt-dlp_linux`, `yt-dlp_linux_aarch64`, and `SHA2-256SUMS`. **Full YouTube support now needs a JS runtime** (deno recommended; node, bun and quickjs also work). Only deno is enabled by default; others are enabled with `--js-runtimes node:<path>`. ffmpeg and ffprobe are needed for extraction, merging, trimming and embedding. | The deps service detects deno and node. The downloader passes `--js-runtimes` explicitly. |
| Frontend libs | react/react-dom **19.3.1**, zustand **5.0.16**, lucide-react **1.62.0**, `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` **5.3.0**, vite **8.3.5** (Node `^20.19 \|\| >=22.12`), vitest **5.0.5** (Node `^22.12 \|\| ^24 \|\| >=26`), @testing-library/react **16.3.3**, typescript **7.0.2** (the native compiler, stable since 2026-07). | `cmdk` was rejected: no release in over a year. The command palette is built in-house (§7.6). |
| This machine | Windows 11. Go **not installed**. wails3 **not installed**. Node **20.18.0** is too old for Vite 8 and Vitest 5. ffmpeg 8.0 is on PATH. yt-dlp, deno and exiftool are missing. The repo `repos/toolbox` exists, has **no commits**, and has an `origin` remote (never pushed to). | See §12.1 for toolchain installation. All builds and tests in this phase run on **Windows**. Mac-specific behaviour is implemented, but you verify it on the Mac (§14). |

---

## 1. Goals

1. A Wails v3 desktop app that runs with `wails3 dev` and builds with `wails3 build` on macOS (Apple Silicon, primary) and Windows.
2. A core that every future tool plugs into: **module registry**, **job system** (queue, concurrency, cancel, retry, persisted, streamed progress and logs), **SQLite library** (jobs, outputs, tags, settings) and **deps service** (detect external CLIs, install and update yt-dlp).
3. A **Downloader** module built on yt-dlp: multiple URLs, audio (mp3/wav/flac + quality) or video (mp4 + max resolution), optional trim, embedded metadata and thumbnail, real progress %, output to `<library>/Downloads`.
4. An **app shell** with a pro-tool feel: sidebar, job tray, global drag-and-drop, recent outputs with reveal, settings, Cmd-K palette, dark and light themes.
5. `CLAUDE.md` with the repo rules, the architecture, and "how to add a module".

## 2. Non-goals (Phase 1)

- Any module other than Downloader. The others appear only as "coming soon" placeholders.
- System tray, global hotkeys, multi-window, native notifications. The architecture must not block them (§4.9).
- Python sidecar. Only `sidecar/README.md` with the planned protocol.
- Auto-installing ffmpeg, ffprobe, deno or exiftool. The app detects them and shows install hints. Only yt-dlp is app-managed.
- Cookies, logins, `--cookies-from-browser`, per-URL format pickers, subtitles, scheduled downloads.
- Tag-editing UI. Tags are stored and auto-assigned, with no editor yet.
- Importing pre-existing files into the library.
- App self-update, code signing, notarization, installers, Linux QA, i18n.
- E2E UI automation. Phase 1 uses unit and component tests plus a manual smoke checklist (§11.3).

---

## 3. Stack and versions (pin these)

**Go** (go.mod: `module toolbox`, `go 1.27`)
- `github.com/wailsapp/wails/v3 v3.0.0`
- `modernc.org/sqlite v1.61.0`
- `github.com/oklog/ulid/v2 v2.1.2`
- Tests use the stdlib `testing` package only. No testify.

**Frontend** (`frontend/package.json`, exact major and minor with `^`)
- deps: `react ^19.3.1`, `react-dom ^19.3.1`, `@wailsio/runtime 3.0.0` (exact), `zustand ^5.0.16`, `lucide-react ^1.62.0`, `@fontsource-variable/geist ^5.3.0`, `@fontsource-variable/geist-mono ^5.3.0`
- devDeps: `typescript ^7.0.2`, `vite ^8.3.5`, `@vitejs/plugin-react ^6.1.2`, `vitest ^5.0.5`, `jsdom` (latest), `@testing-library/react ^16.3.3`, `@testing-library/user-event` (latest 14.x+), `@types/react ^19`, `@types/react-dom ^19`
- **Fallback rule:** if TypeScript 7 breaks `vite`, `vitest` or the generated bindings, drop to `typescript ~6.0.3` and log it in DECISIONS.md.
- **No** UI component library, no CSS framework, no router, no fetch or HTTP client. Styling uses **CSS Modules** (`*.module.css`) plus global token CSS.

---

## 4. Architecture

### 4.1 Layers

```
┌──────────── frontend (React, TS strict) ────────────┐
│ shell/  tools/<module>/  views/  components/        │
│ state/ (zustand stores)  lib/ (api, events, …)      │
└───────────────▲─────────────────────▲───────────────┘
   generated TS bindings (calls)   typed Wails events
┌───────────────┴─────────────────────┴───────────────┐
│ api/  thin Wails services, error marshalling,       │
│       event registration, Wails→core adapters       │
├──────────────────────────────────────────────────────┤
│ core/  registry · jobs · jobcontext · errors ·      │
│        types · events · paths · proc                │
│ core/store  SQLite (jobs, logs, outputs, settings)  │
│ core/deps   detection + managed yt-dlp updater      │
├──────────────────────────────────────────────────────┤
│ modules/downloader  modules/placeholders  (sidecar) │
└──────────────────────────────────────────────────────┘
```

Rules:
- `core` and everything under it **must not import Wails**. Wails appears only in `main.go` and `api/`. This keeps core fully unit-testable.
- `core` doesn't import `modules/*`. Modules import `core`.
- The frontend never knows which binary or language does the work. It sees module descriptors, jobs, outputs, deps and settings.

### 4.2 Module contract (improved from the brief)

Changes from the brief, and why:
1. `ID/Name/Accepts` become a single **`Descriptor`** value. It is serializable, so the UI gets icons, categories and status from it, and placeholders can be registered without code.
2. **`Validate`** is added so bad input fails synchronously at submit, with field-level errors, instead of producing a failed job.
3. Options are **`json.RawMessage`** decoded by the module into its own typed struct (`core.DecodeOptions[T]`), not `map[string]any`. Each module exposes a **typed Wails service** for submission, so TS gets real option types and there is no `any` at the boundary.
4. `Job` (the persisted record) and **`JobContext`** (what `Run` receives) are separate. `JobContext` adds `OutputDir`, `TempDir`, `SetTitle` and `Tool(depID)`.

```go
// core/module.go
type Category string      // "media" | "audio" | "image" | "document" | "ai" | "utility"
type ModuleStatus string  // "ready" | "coming_soon"

type Accepts struct {
    Extensions []string `json:"extensions"` // lowercase with leading dot, e.g. ".mp3"
    URLs       bool     `json:"urls"`
}

type Descriptor struct {
    ID           string       `json:"id"`           // kebab-case, stable, e.g. "downloader"
    Name         string       `json:"name"`         // "Downloader"
    Tagline      string       `json:"tagline"`      // ≤ 60 chars, shown in palette and tooltips
    Description  string       `json:"description"`  // 1–3 sentences, shown on placeholder view
    Icon         string       `json:"icon"`         // lucide icon name (kebab-case)
    Category     Category     `json:"category"`
    Status       ModuleStatus `json:"status"`
    Accepts      Accepts      `json:"accepts"`
    Requires     []string     `json:"requires"`     // dep IDs that must be present to run
    Recommends   []string     `json:"recommends"`   // dep IDs that improve results
    OutputSubdir string       `json:"outputSubdir"` // relative to library dir, e.g. "Downloads"; "" = no outputs
    Order        int          `json:"order"`        // sidebar ordering (ascending)
    Hidden       bool         `json:"hidden"`       // system modules (not listed / not matched)
    SplitInputs  bool         `json:"-"`            // true → one job per input
    MaxConcurrent int         `json:"-"`            // 0 = limited only by global concurrency
}

type Module interface {
    Descriptor() Descriptor
    // Validate is called synchronously at submit time with the already-split inputs.
    // Return *AppError{Code: CodeValidation, Fields: …} for bad input.
    Validate(inputs []string, options json.RawMessage) error
    // Run does the work. Honour ctx cancellation promptly. Report via job.
    Run(ctx context.Context, job *JobContext) error
}
```

Placeholder ("coming soon") modules are registered with `registry.RegisterPlaceholder(Descriptor)`. They have no `Run`, are listed and matched, but can't be submitted.

```go
// core/jobcontext.go (written in foundation, complete)
type LogStream string // "stdout" | "stderr" | "system"
const IndeterminateProgress = -1.0

type JobContext struct {
    ID        string
    ModuleID  string
    Inputs    []string
    Options   json.RawMessage
    Attempt   int
    OutputDir string // <library>/<OutputSubdir>; created before Run
    TempDir   string // <support>/tmp/<jobID>; created before Run, deleted after Run returns
    // unexported hooks set by NewJobContext
}

type JobHooks struct {
    Progress func(pct float64, msg string)
    Log      func(stream LogStream, line string)
    Title    func(title string)
    Output   func(path string) (Output, error)
    Tool     func(depID string) (string, error)
}

func NewJobContext(base JobContext, hooks JobHooks) *JobContext // used by core and by module tests
func (j *JobContext) Progress(pct float64, msg string)  // pct ∈ [0,1] or IndeterminateProgress
func (j *JobContext) Log(stream LogStream, line string)
func (j *JobContext) Logf(format string, args ...any)    // system stream
func (j *JobContext) SetTitle(title string)              // e.g. the video title once known
func (j *JobContext) Output(path string) (Output, error) // registers a finished file in the library
func (j *JobContext) Tool(depID string) (string, error)  // absolute path or *AppError{CodeDependencyMissing}
func DecodeOptions[T any](j *JobContext) (T, error)       // strict: DisallowUnknownFields
```

### 4.3 Core wire types (`core/types.go`, all JSON-tagged camelCase; times are Unix **milliseconds** `int64`, 0 = unset)

```go
type JobStatus string // "queued" | "running" | "done" | "failed" | "cancelled"

type Job struct {
    ID, ModuleID, Title string
    Status          JobStatus
    Progress        float64   // 0..1, or -1 indeterminate
    Message         string    // current human-readable step, e.g. "Downloading · 4.2 MiB/s · ETA 0:31"
    Inputs          []string
    OptionsJSON     string    `json:"optionsJson"`
    ErrorCode       ErrorCode `json:"errorCode"` // "" unless failed
    Error           string
    ErrorHint       string    `json:"errorHint"`
    Attempt         int
    CancelRequested bool      `json:"cancelRequested"` // transient; true between Cancel() and status change
    CreatedAt, StartedAt, FinishedAt int64
    Outputs         []Output  // outputs registered by this job (all attempts)
}

type JobFilter struct {
    ModuleID string; Statuses []JobStatus; Limit int // default 100, max 500; newest first
}

type JobProgress struct { ID string; Progress float64; Message string }
type LogLine     struct { Seq int; TS int64; Stream LogStream; Text string }
type JobLogBatch struct { ID string; Lines []LogLine }
type JobsRemoved struct { IDs []string }

type OutputKind string // "audio" | "video" | "image" | "document" | "other"
type Output struct {
    ID, JobID, ModuleID, Path, Name string // Name = base name
    Kind      OutputKind
    SizeBytes int64
    CreatedAt int64
    Tags      []string
    Missing   bool // computed on read: file no longer exists
}
type OutputQuery struct { ModuleID, Search string; Limit int /*default 100, max 500*/; Cursor string }
type OutputPage  struct { Items []Output; NextCursor string } // "" = end
type OutputsRemoved struct { IDs []string }

type Theme string // "system" | "dark" | "light"
type Settings struct { LibraryDir string; Concurrency int; Theme Theme }
type SettingsPatch struct { LibraryDir *string; Concurrency *int; Theme *Theme }

type DepState  string // "ok" | "missing" | "error"
type DepSource string // "managed" | "path" | "known-dir" | ""
type DepStatus struct {
    ID, Name, Purpose string
    State       DepState
    Version     string
    Path        string
    Source      DepSource
    Managed     bool     // app can install/update it (yt-dlp only in Phase 1)
    Required    bool     // required by at least one ready module
    RequiredBy  []string // module IDs
    RecommendedBy []string
    InstallHint string   // OS-specific, e.g. "brew install ffmpeg"
    Error       string
    CheckedAt   int64
}
type DepsChanged struct { Deps []DepStatus }

type ModuleMatch  struct { Module Descriptor; Paths []string }
type MatchResult  struct { Matches []ModuleMatch; Unmatched []string } // ready first, then Order
type FilesDropped struct { Paths []string; Result MatchResult }
type Navigate     struct { Target string } // "settings" | "library" | module ID

type AppInfo struct { Version, OS, Arch, SupportDir, DBPath, LogPath, LibraryDir string }
```

### 4.4 Errors (`core/errors.go`)

```go
type ErrorCode string
const (
    CodeValidation        ErrorCode = "validation"
    CodeDependencyMissing ErrorCode = "dependency_missing"
    CodeNotFound          ErrorCode = "not_found"
    CodeConflict          ErrorCode = "conflict"     // e.g. update yt-dlp while downloads run
    CodeToolFailed        ErrorCode = "tool_failed"  // external tool exited non-zero
    CodeCancelled         ErrorCode = "cancelled"
    CodeInterrupted       ErrorCode = "interrupted"  // app quit while running
    CodeNotImplemented    ErrorCode = "not_implemented"
    CodeInternal          ErrorCode = "internal"
)
type AppError struct {
    Code    ErrorCode         `json:"code"`
    Message string            `json:"message"`         // user-facing, sentence case, no trailing period
    Hint    string            `json:"hint,omitempty"`  // user-facing next step
    Fields  map[string]string `json:"fields,omitempty"`// field → message (validation)
    Err     error             `json:"-"`               // wrapped cause, for logs
}
func (e *AppError) Error() string; func (e *AppError) Unwrap() error
func Errorf(code ErrorCode, format string, args ...any) *AppError
func AsAppError(err error) *AppError // wraps non-AppErrors as CodeInternal (message "Something went wrong"), keeps cause
func ErrDependencyMissing(depID string, hint string) *AppError
```

- All Go errors are wrapped with context: `fmt.Errorf("open db %s: %w", path, err)`.
- Every Wails service is registered with `MarshalError: api.MarshalError`, which emits `AsAppError(err)` as JSON and logs the full cause chain through slog.
- Frontend: `lib/errors.ts` exports `toAppError(e: unknown): AppErrorShape` (reads `e.cause` if it's an object with `code`, else `{code:"internal", message: String(e)}`).

### 4.5 Events (registered in `api/events.go` `init()`, names as consts in `core/events.go`)

| Name | Payload | Emitted when |
|---|---|---|
| `jobs:changed` | `Job` | insert, status change, title change, cancel requested, retry |
| `jobs:removed` | `JobsRemoved` | remove / clear finished |
| `jobs:progress` | `JobProgress` | throttled: **≤ 1 per 100 ms per job**, trailing edge always delivered |
| `jobs:log` | `JobLogBatch` | batched every **150 ms** per job |
| `library:added` | `Output` | output registered |
| `library:removed` | `OutputsRemoved` | output removed from library |
| `deps:changed` | `DepsChanged` | after detection / install |
| `settings:changed` | `Settings` | after successful update |
| `app:files-dropped` | `FilesDropped` | native file drop on main window |
| `app:navigate` | `Navigate` | native menu item (e.g. Settings… ⌘,) |

Core emits through `core.Emitter interface { Emit(name string, data any) }`. `api` adapts it to `app.Event.Emit`. Throttling and batching live in core (`core/throttle.go`, owned by WP-B) so they are testable.

### 4.6 Job system semantics (`core/jobs.go`)

- **Submit(moduleID, inputs, optionsJSON)** → look up the module (not found → `not_found`, placeholder → `validation` "Coming soon"). Trim and dedupe inputs, keeping order. Call `Validate`. If `SplitInputs`, create one job per input; otherwise one job. Persist as `queued`, emit `jobs:changed`, kick the scheduler. Returns the created jobs.
- **Scheduler:** FIFO by `CreatedAt`, then ID. Runs while `running < Concurrency` and the module's `MaxConcurrent` isn't exceeded. A skipped job doesn't block jobs of other modules behind it. Concurrency defaults to **3**, range **1–8**. `SetConcurrency(n)` takes effect immediately; lowering it never kills running jobs.
- **Run lifecycle:** set `running` and `StartedAt`. Create `OutputDir` (MkdirAll) and `TempDir`. Call `Run` in a goroutine with a per-job cancellable context **derived from the manager's root context**. Recover panics, which become `internal` with the stack logged. On return:
  - cancellation was requested → `cancelled` (regardless of error)
  - `nil` → `done`, progress 1
  - error → `failed` with `AsAppError(err)` code, message and hint
  - in every case: set `FinishedAt`, delete `TempDir`, flush logs, emit `jobs:changed`.
- **Cancel(id):** if queued → `cancelled` immediately. If running → set `CancelRequested`, emit, cancel the ctx. Finished jobs → no-op. Unknown → `not_found`.
- **CancelAll():** cancels every queued and running job.
- **Retry(id):** only for `failed` or `cancelled` (otherwise `conflict`). Same job ID: `Attempt++`, status `queued`, progress 0, error cleared, `FinishedAt`/`StartedAt` reset. A system log line `── attempt N ──` is appended. Existing outputs are kept.
- **Remove(id):** only for finished jobs (otherwise `conflict`). Deletes the job row and its logs. Outputs stay in the library with `job_id = NULL`. **ClearFinished()** removes all done, failed and cancelled jobs and returns the count.
- **Logs:** each line is pushed to subscribers (batched event) and persisted in batches (≤ every 500 ms). The cap is **10,000 lines per job**. After that a single system line `… further output truncated …` is written and later lines are dropped (they still show in the live event stream). Lines longer than 4 KB are truncated.
- **Progress:** values are clamped to [0,1]. Within one attempt the manager never lets a determinate value decrease (`max(prev, new)`). Indeterminate passes through. Progress is persisted only on status change.
- **Startup recovery:** jobs found `running` → `failed` with `interrupted` ("Interrupted when Toolbox quit", hint "Retry to run it again"). Jobs found `queued` → re-enqueued in order. Everything in `<support>/tmp` is deleted.
- **Shutdown** (`ServiceShutdown`): stop scheduling, cancel all running jobs, wait **≤ 5 s** for them to return, flush logs, close.
- **HasActive(moduleIDs ...string) bool:** used to block a yt-dlp update while downloads run.

### 4.7 Process execution (`core/proc`, foundation)

```go
type Spec struct {
    Path string; Args []string; Dir string
    Env  []string                 // appended to os.Environ()
    OnStdout, OnStderr func(line string) // called per line (split on \n and \r, CR-terminated progress handled), UTF-8, trailing \r\n trimmed
}
type Result struct { ExitCode int; StderrTail []string /* last 50 stderr lines */ }
func Run(ctx context.Context, s Spec) (Result, error) // error wraps *exec.ExitError or ctx.Err()
func Output(ctx context.Context, timeout time.Duration, path string, args ...string) (string, error) // short commands (version checks)
```

- **Whole-tree kill on cancel.** On Unix, `SysProcAttr{Setpgid:true}`. On cancel, SIGTERM the process group, then SIGKILL after 3 s. On Windows, `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` with `HideWindow:true`. On cancel, `taskkill /T /F /PID <pid>` (started with the same hidden flags). Uses `cmd.Cancel` and `cmd.WaitDelay = 5s`.
- **No console window flashes on Windows** for any subprocess, including version checks.
- Test: a re-exec helper (`TestHelperProcess` pattern) spawns a child that spawns a grandchild sleeper. Cancel kills both within 5 s, verified by PID liveness.

### 4.8 Security, privacy, filesystem

- No network listeners in the production app. Never use the `server` or `mcp` build tags. The `wails3 dev` Vite server on `127.0.0.1:9245` is dev-only and logged as an accepted exception in DECISIONS.md.
- Outbound network: only yt-dlp itself (downloads) and the **user-triggered** yt-dlp install/update (api.github.com plus GitHub release asset hosts). There is no update check at startup. No telemetry. Fonts are bundled, so no Google Fonts.
- Input files are never modified. Downloads are written to `TempDir` and yt-dlp moves them into `OutputDir`.
- **Paths** (`core/paths.go`):
  - Support dir: `os.UserConfigDir()/Toolbox` (macOS `~/Library/Application Support/Toolbox`, Windows `%AppData%\Toolbox`). Overridden by the `TOOLBOX_SUPPORT_DIR` env var (dev and tests).
  - Inside it: `toolbox.db`, `bin/`, `tmp/`, `cache/yt-dlp/`, `logs/toolbox.log` (rotated on startup when larger than 5 MB to `toolbox.log.1`).
  - Default library dir: `~/Toolbox`, overridden on first run by `TOOLBOX_LIBRARY_DIR` (dev and tests). After that, the settings value wins.
- `api.LibraryService.RevealPath`/`OpenPath` only accept paths inside the library dir or support dir (`conflict` otherwise). This prevents arbitrary-path launching from the UI.
- Single instance: `SingleInstanceOptions{UniqueID: "dev.toolbox.app"}`. A second launch focuses the existing window.

### 4.9 Not blocking later phases

- **Multi-window:** frontend views are addressed by a view ID (`library`, `settings`, or a module ID). `App.tsx` reads an optional `?view=` query param, so a future window (e.g. the clipboard popup) can load `/?view=clipboard`. Stores subscribe to events independently per window.
- **Tray and global hotkeys:** `main.go` keeps the `*application.App`. Hotkeys use `app.GlobalShortcut`. No extra deps are needed.
- **Sidecar:** `sidecar/README.md` documents the planned protocol. One long-running `uv run` Python process. JSON Lines over stdio. Requests `{"id","method","params"}`, responses `{"id","result"}` or `{"id","error":{"code","message"}}`, streaming `{"id","event":"progress","data":{…}}`, cancellation `{"id","method":"$cancel"}`. Modules will call it through a Go client behind the same `Module` interface.
- **New modules:** a folder under `modules/` with a `Register(r *core.Registry, deps …)` function and a folder under `frontend/src/tools/<id>/`. Nothing in shell or core changes (see CLAUDE.md "How to add a module").

---

## 5. Data schema (`core/store/migrations/0001_init.sql`)

The database is opened with DSN pragmas: `journal_mode(WAL)`, `busy_timeout(5000)`, `foreign_keys(1)`, `synchronous(NORMAL)`. It uses `db.SetMaxOpenConns(1)`. Migrations are embedded (`embed.FS`), applied in filename order, each in its own transaction, and recorded in `schema_migrations`. The migrator is written in-house (~50 lines). Re-running it is a no-op.

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,                 -- ULID
  module_id    TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  progress     REAL NOT NULL DEFAULT 0,
  message      TEXT NOT NULL DEFAULT '',
  inputs       TEXT NOT NULL,                    -- JSON array of strings
  options      TEXT NOT NULL DEFAULT '{}',       -- JSON object
  error_code   TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  error_hint   TEXT NOT NULL DEFAULT '',
  attempt      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,                 -- unix ms
  started_at   INTEGER NOT NULL DEFAULT 0,
  finished_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_status_idx  ON jobs(status);
CREATE INDEX jobs_created_idx ON jobs(created_at DESC, id DESC);

CREATE TABLE job_logs (
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  stream  TEXT NOT NULL CHECK (stream IN ('stdout','stderr','system')),
  line    TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE outputs (
  id          TEXT PRIMARY KEY,                  -- ULID
  job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  module_id   TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,              -- absolute, cleaned
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('audio','video','image','document','other')),
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX outputs_created_idx ON outputs(created_at DESC, id DESC);
CREATE INDEX outputs_module_idx  ON outputs(module_id, created_at DESC);

CREATE TABLE output_tags (
  output_id TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (output_id, tag)
);
CREATE INDEX output_tags_tag_idx ON output_tags(tag);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                      -- JSON
  updated_at INTEGER NOT NULL
);
```

- **Output upsert:** inserting an existing `path` updates `job_id`, `module_id`, `size_bytes` and `created_at` and keeps the original `id`. This covers re-downloading a file yt-dlp reports as already present.
- **Auto tags:** `module:<moduleID>` and `kind:<kind>`.
- **Kind by extension:** audio `.mp3 .wav .flac .m4a .aac .ogg .opus .aiff .aif`. Video `.mp4 .mov .mkv .webm .m4v .avi`. Image `.jpg .jpeg .png .webp .gif .heic .tif .tiff .bmp`. Document `.pdf .txt .md .json .csv`. Anything else is other.
- **Paging cursor:** opaque base64 of `created_at:id`. Search is a case-insensitive `LIKE` on `name`.
- **Settings keys:** `libraryDir`, `concurrency`, `theme`, `moduleState:<moduleID>` (opaque JSON owned by that module's UI, e.g. last-used downloader options).

`core/store` provides `Open(path) (*DB, error)`, which implements `core.JobStore`, `core.OutputStore` and `core.SettingsStore` (interfaces in `core/interfaces.go`, written in foundation):

```go
type JobStore interface {
    InsertJob(ctx context.Context, j Job) error
    UpdateJob(ctx context.Context, j Job) error           // all mutable columns
    GetJob(ctx context.Context, id string) (Job, error)   // *AppError CodeNotFound
    ListJobs(ctx context.Context, f JobFilter) ([]Job, error) // Outputs populated
    DeleteJobs(ctx context.Context, ids []string) error
    AppendLogs(ctx context.Context, jobID string, lines []LogLine) error
    Logs(ctx context.Context, jobID string) ([]LogLine, error)
    CountLogs(ctx context.Context, jobID string) (int, error)
}
type OutputStore interface {
    UpsertOutput(ctx context.Context, o Output) (Output, error)
    GetOutput(ctx context.Context, id string) (Output, error)
    ListOutputs(ctx context.Context, q OutputQuery) (OutputPage, error) // Missing computed via os.Stat
    DeleteOutput(ctx context.Context, id string) error
}
type SettingsStore interface {
    GetSetting(ctx context.Context, key string) (value string, ok bool, err error)
    SetSetting(ctx context.Context, key, value string) error
}
```

---

## 6. Services

### 6.1 Settings (`core/settings.go`, WP-A)

```go
type SettingsService struct{ /* store, emitter, mu, cached Settings */ }
func NewSettingsService(store SettingsStore, em Emitter, defaultLibraryDir string) (*SettingsService, error) // loads or writes defaults
func (s *SettingsService) Current() Settings
func (s *SettingsService) Update(ctx context.Context, p SettingsPatch) (Settings, error)
func (s *SettingsService) ModuleState(ctx context.Context, moduleID string) (string, error) // "" if unset
func (s *SettingsService) SetModuleState(ctx context.Context, moduleID, stateJSON string) error // must be valid JSON ≤ 64 KB
func (s *SettingsService) OnChange(fn func(old, new Settings)) // used by main wiring (concurrency → jobs)
```

Validation (all `validation` with `Fields`):
- `libraryDir`: absolute. Created if missing (MkdirAll 0755). Must be writable (probe by creating and removing a temp file). Must not be inside the support dir.
- `concurrency`: 1–8.
- `theme`: one of the three enum values.

Defaults: `libraryDir` = `TOOLBOX_LIBRARY_DIR` or `~/Toolbox`, concurrency 3, theme `dark`.

### 6.2 Registry (`core/registry.go`, foundation, complete)

```go
func NewRegistry() *Registry
func (r *Registry) Register(m Module) error                // dup ID → error
func (r *Registry) RegisterPlaceholder(d Descriptor) error // forces Status = coming_soon
func (r *Registry) Get(id string) (Module, bool)            // placeholders return false
func (r *Registry) Descriptor(id string) (Descriptor, bool)
func (r *Registry) List() []Descriptor                      // non-hidden, sorted by Order then Name
func (r *Registry) Match(paths []string) MatchResult        // by extension, case-insensitive; dirs → Unmatched
func (r *Registry) RequiringDep(depID string) []string      // module IDs (ready) requiring it
```

### 6.3 Deps (`core/deps`, WP-C)

```go
type Spec struct {
    ID, Name, Purpose string
    Binary       string                 // base name without .exe
    VersionArgs  []string
    VersionRegex *regexp.Regexp         // first capture group = version
    Managed      bool
    InstallHint  map[string]string      // GOOS → hint
}
func Catalog() []Spec
type Service struct{ … }
func New(binDir string, specs []Spec, reg *core.Registry, em core.Emitter) *Service
func (s *Service) Resolve(depID string) (string, error) // implements the JobHooks.Tool contract; uses cached detection, re-detects a missing dep once on demand
func (s *Service) List() []core.DepStatus
func (s *Service) Detect(ctx context.Context) []core.DepStatus // parallel, 5 s timeout each; emits deps:changed
func (s *Service) BinDir() string
```

**Catalog:**

| ID | Binary | Version args → regex | Managed | Role (Phase 1) | Hint mac / win |
|---|---|---|---|---|---|
| `yt-dlp` | `yt-dlp` | `--version` → `^(\S+)` | yes | required by downloader | "Install from Settings → Dependencies" (also mention `brew install yt-dlp`) / same, plus `winget install yt-dlp.yt-dlp` |
| `ffmpeg` | `ffmpeg` | `-version` → `ffmpeg version (\S+)` | no | required by downloader | `brew install ffmpeg` / `winget install Gyan.FFmpeg` |
| `ffprobe` | `ffprobe` | `-version` → `ffprobe version (\S+)` | no | required by downloader | (comes with ffmpeg) |
| `deno` | `deno` | `--version` → `deno (\S+)` | no | recommended by downloader | `brew install deno` / `winget install DenoLand.Deno` |
| `node` | `node` | `--version` → `v?(\S+)` | no | recommended (fallback JS runtime) | `brew install node` / `winget install OpenJS.NodeJS.LTS` |
| `exiftool` | `exiftool` | `-ver` → `^(\S+)` | no | none yet (future EXIF module) | `brew install exiftool` / `winget install OliverBetz.ExifTool` |

**Resolution order** (first hit wins, `.exe` appended on Windows):
1. `<support>/bin/<binary>` → source `managed`
2. `exec.LookPath` → source `path`
3. Known dirs, needed because **GUI apps launched from Finder don't get the shell PATH**:
   - mac: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `~/.deno/bin`
   - win: `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%USERPROFILE%\scoop\shims`, `%USERPROFILE%\.deno\bin`, `%ProgramFiles%\nodejs`

   Source is `known-dir`.

A binary that's found but whose version command fails or times out → state `error` with the message.

**Managed yt-dlp install/update** is a hidden system module `system-ytdlp-update` (in `core/deps/ytdlp_update.go`) so it gets the job tray, progress, logs and cancel for free.
- `Descriptor{Hidden:true, MaxConcurrent:1, OutputSubdir:""}`
- Steps:
  1. GET `https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest` (`User-Agent: Toolbox/<version>`, 15 s timeout).
  2. If a managed binary exists and its version equals `tag_name`, finish with message `Already up to date (<tag>)`.
  3. Pick the asset: darwin → `yt-dlp_macos`, windows/amd64 → `yt-dlp.exe`, windows/arm64 → `yt-dlp_arm64.exe`, linux/amd64 → `yt-dlp_linux`, linux/arm64 → `yt-dlp_linux_aarch64`. Anything else → `internal` "Unsupported platform".
  4. Download `SHA2-256SUMS` and the asset into `TempDir`, with byte progress (0–95 %). Size cap 200 MB. ctx-cancellable.
  5. Verify SHA-256 against the sums line for that asset name. A mismatch → `tool_failed` "Checksum mismatch".
  6. `chmod 0755`, rename to `<bin>/yt-dlp[.exe]` (same filesystem: TempDir is under support).
  7. Run `--version` to confirm, then `Detect` and emit `deps:changed`.
- The GitHub base URL is a field on the module struct so tests can use an `httptest` server.
- `api.DepsService.UpdateYtDlp()` returns `conflict` ("Wait for running downloads to finish") if `jobs.HasActive(registry.RequiringDep("yt-dlp")...)`.

---

## 7. Downloader module (`modules/downloader`, WP-D)

### 7.1 Descriptor

```
ID "downloader", Name "Downloader", Tagline "Grab audio or video from a link",
Icon "download", Category "media", Status ready, Accepts {URLs:true},
Requires ["yt-dlp","ffmpeg","ffprobe"], Recommends ["deno"], OutputSubdir "Downloads",
Order 10, SplitInputs true, MaxConcurrent 0
```

### 7.2 Options (`options.go`, exported, appear in TS bindings)

```go
type Mode string;          const ( ModeAudio Mode = "audio"; ModeVideo Mode = "video" )
type AudioFormat string;   const ( MP3 = "mp3"; WAV = "wav"; FLAC = "flac" )
type AudioQuality string;  const ( QBest = "best"; Q320 = "320"; Q256 = "256"; Q192 = "192"; Q128 = "128" )
type MaxResolution string; const ( ResBest = "best"; Res2160 = "2160"; Res1440 = "1440"; Res1080 = "1080"; Res720 = "720"; Res480 = "480"; Res360 = "360" )

type Options struct {
    Mode           Mode          `json:"mode"`
    AudioFormat    AudioFormat   `json:"audioFormat"`
    AudioQuality   AudioQuality  `json:"audioQuality"`   // used only for mp3
    MaxResolution  MaxResolution `json:"maxResolution"`
    TrimEnabled    bool          `json:"trimEnabled"`
    TrimStart      string        `json:"trimStart"`      // "" = 0
    TrimEnd        string        `json:"trimEnd"`        // "" = end of media
    EmbedMetadata  bool          `json:"embedMetadata"`
    EmbedThumbnail bool          `json:"embedThumbnail"` // ignored (with log line) for wav
    Playlist       bool          `json:"playlist"`       // false → --no-playlist
}
func DefaultOptions() Options // audio, mp3, "320", "1080", trim off, embed both on, playlist off
```

### 7.3 Validation (`Validate`, and the same rules mirrored in TS for live feedback)

- Inputs: 1–50 URLs. Each must parse with `net/url` with scheme `http` or `https` and a non-empty host. Errors are reported per input: `Fields["inputs.<i>"]`.
- Enum fields must be valid values.
- **Timecode grammar** (both Go and TS): `SS[.fff]`, `M:SS[.fff]`, `MM:SS[.fff]` and `H:MM:SS[.fff]`, where minutes and seconds in non-leading positions are < 60. Values are parsed to float seconds.
- With `TrimEnabled`: at least one of start or end is set, `start ≥ 0`, and if both are set `end > start`. Error fields are `trimStart`/`trimEnd`.
- Dependencies are **not** checked in Validate. `Run` calls `job.Tool()`, so a missing dep fails the job with a clear hint. The UI also pre-checks from deps state and disables submit (§8.3).

### 7.4 yt-dlp invocation (`args.go`, pure function `BuildArgs(opts, input, env ArgEnv) []string`; table-tested)

`ArgEnv{OutputDir, TempDir, CacheDir, FFmpegPath, JSRuntime /* "deno:<path>" | "node:<path>" | "" */}`

Always passed, in this order:

```
--ignore-config --color never
--newline --progress --no-simulate --no-mtime
--encoding utf-8
--cache-dir <CacheDir>
--ffmpeg-location <FFmpegPath>
[--js-runtimes <JSRuntime>]                       (omitted if "")
-P home:<OutputDir> -P temp:<TempDir>
--progress-template "download:[tbx:dl] %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|%(info.n_entries)s"
--progress-template "postprocess:[tbx:pp] %(progress.status)s|%(progress.postprocessor)s"
--print "before_dl:[tbx:start] %(id)s|%(format_id)s|%(playlist_index)s|%(n_entries)s|%(title)s"
--print "after_move:[tbx:out] %(filepath)s"
```

Playlist: `--no-playlist` when `Playlist=false`, else `--yes-playlist`.

Output template (`-o`), with `<cut>` = `" [cut <a>-<b>]"` when trimming. `a`/`b` are formatted like `1m05s`, `0m00s`, or `end`.
- single: `%(title).150B [%(id)s]<cut>.%(ext)s`
- playlist: `%(playlist_title,playlist_id).80B/%(playlist_index)03d - %(title).150B [%(id)s]<cut>.%(ext)s`

**Audio mode:**
```
-f "ba/b" -x --audio-format <mp3|wav|flac>
[--audio-quality <0 | 320K | 256K | 192K | 128K>]   (mp3 only; "best" → 0)
```

**Video mode** (`N` = max resolution; `best` drops the height filters and the `res:` sort key):
```
-f "bv*[height<=N]+ba/b[height<=N]/bv*+ba/b"
-S "res:N,vcodec:h264,acodec:aac"
--merge-output-format mp4 --remux-video mp4
```

**Trim:** `--download-sections "*<startSec>-<endSec|inf>"` (seconds as decimal, `startSec` defaults to `0`). Also `--force-keyframes-at-cuts` in video mode.

**Embedding:**
- `EmbedMetadata` → `--embed-metadata`, plus `--embed-chapters` when not trimming.
- `EmbedThumbnail` and format ≠ wav → `--embed-thumbnail --convert-thumbnails jpg`.
- For wav, a system log line: "Thumbnail embedding isn't supported for WAV, skipped".

The input URL is the last argument, preceded by `--`.

**Process env:** `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, `NO_COLOR=1`. `PATH` is prefixed with the support `bin/` dir and the directory of the resolved ffmpeg.

**JS runtime selection** (in `Run`): deno resolved → `deno:<path>`. Else node resolved → `node:<path>` (log "Using Node.js as JavaScript runtime"). Else `""` (log a warning "No JavaScript runtime found; some YouTube formats may be unavailable. Install Deno: <hint>").

### 7.5 Progress parsing (`progress.go`, pure, the main test target)

```go
type EventKind int // EvStart, EvDownload, EvPostprocess, EvOutput, EvError, EvOther
type Event struct {
    Kind EventKind
    // EvStart
    ID, FormatID, Title string; PlaylistIndex, PlaylistCount int // 0 if NA
    // EvDownload
    Status string; Downloaded, Total, TotalEstimate, Speed, ETA float64 // -1 if NA
    // EvPostprocess
    PPStatus, Postprocessor string
    // EvOutput
    Path string
    // EvError (line starts with "ERROR:")
    Message string
}
func ParseLine(line string) Event        // never panics; unknown → EvOther
type Tracker struct{ … }
func NewTracker() *Tracker
func (t *Tracker) Apply(e Event) (pct float64, msg string, changed bool)
```

**Parsing rules.**
- Fields are `|`-separated. `title` is the **last** field of `[tbx:start]` and may itself contain `|`, so split with `SplitN`.
- `NA`, `None` and empty → -1 (or 0 for indices).
- Numbers may be ints or floats.

**Tracker model.** Each item has `streams = strings.Count(formatID, "+") + 1` (minimum 1). The item fraction is:

```
download part (0 → 0.90):  (streamsDone + f) / streams * 0.90
   f = downloaded / (total > 0 ? total : totalEstimate)
   indeterminate if neither total is known
   a download event with status "finished" → streamsDone++ (capped at streams)
postprocess part (0.90 → 0.99):  each new postprocessor "started" adds 0.03, capped at 0.99
EvOutput → item complete (1.0)
```

Overall = `((itemIndex-1) + itemFrac) / max(1, itemCount)`. The index and count come from `[tbx:start]`, falling back to the `[tbx:dl]` fields.

**If the current download is indeterminate**, the whole overall value is `IndeterminateProgress` (this happens when trimming via the ffmpeg downloader, which reports bytes without a total).

**Messages** (prefix `Item i/n · ` when n > 1):
- download: `Downloading` (single stream) or `Downloading video` / `Downloading audio` (stream 1/2 and 2/2 of a merge), then ` · <speed>/s · ETA m:ss`. Sizes in binary units with 1 decimal: `4.2 MiB`. When the total is unknown: `Downloading · 12.3 MiB`.
- postprocess names: `ExtractAudio`→`Extracting audio`, `Merger`→`Merging streams`, `FFmpegVideoRemuxer`→`Remuxing`, `EmbedThumbnail`→`Embedding thumbnail`, `FFmpegMetadata`→`Writing metadata`, `ModifyChapters`→`Trimming`, `MoveFiles`→`Finalizing`. Any other → its raw name.

**Run loop.** stdout/stderr lines go through `ParseLine`.
- Every non-`[tbx:*]` line goes to `job.Log` (`[tbx:*]` lines are not logged, to keep logs readable, **except** `[tbx:start]` and `[tbx:out]`, which are logged as system lines `Starting "<title>"` and `Saved <path>`).
- `EvStart` with a title → `job.SetTitle(title)` (playlist: `"<title> (+n-1 more)"` on the first item only).
- `EvOutput` → `job.Output(path)`. Paths are deduplicated within the job.
- Exit 0 but no outputs → `tool_failed` "yt-dlp finished without producing a file".
- Non-zero exit → `tool_failed` with message = the last `ERROR:` line (prefix stripped), or the last stderr line, or "yt-dlp exited with code N".

**Hint mapping** (case-insensitive substring):

| Substring | Hint |
|---|---|
| `Unsupported URL` | "This site isn't supported by yt-dlp" |
| `Requested format is not available` | "Try a lower max resolution or Best" |
| `Sign in to confirm` / `cookies` | "This video needs a signed-in session, which Toolbox doesn't support yet" |
| `HTTP Error 403` / `nsig` / `Signature extraction failed` | "Update yt-dlp in Settings → Dependencies" (plus the Deno hint if no JS runtime) |
| `ffmpeg not found` / `ffprobe` | the ffmpeg install hint |
| `Private video` / `Video unavailable` | "The video is private or unavailable" |

### 7.6 Typed module service (`service.go`, bound in Wails)

```go
type Service struct{ jobs *core.Jobs; reg *core.Registry }
func NewService(jobs *core.Jobs) *Service
func (s *Service) Defaults() Options
func (s *Service) Enqueue(urls []string, opts Options) ([]core.Job, error) // marshals opts → core.Jobs.Submit("downloader", urls, json)
```

`func Register(reg *core.Registry, resolve func(string) (string, error), cacheDir string) error` registers the module.

### 7.7 Tests (required)

- `progress_test.go`: table tests for `ParseLine`, including NA fields, floats, a title with `|`, and ERROR lines. Golden replay tests run **fixture transcripts** from `testdata/*.txt` through Tracker and assert monotonic pct, the final 1.0, and the key messages. Required fixtures (hand-authored to mirror real yt-dlp 2026.10 output with our templates):
  - `audio_mp3.txt`
  - `video_merge_2streams.txt`
  - `unknown_total.txt`
  - `trim_section.txt` (indeterminate)
  - `playlist_3.txt`
  - `error_unavailable.txt`
- `args_test.go`: table tests for `BuildArgs` across audio/video × trim × embed × playlist × JS runtime, plus wav-skips-thumbnail and the `best` resolution.
- `validate_test.go`: URL and timecode grammar, including edge cases (`1:60` invalid, `0:59.5` valid, `end ≤ start` invalid).
- `run_test.go`: `Run` against a **fake yt-dlp** built from a test helper (re-exec pattern) that replays a fixture and creates the output file. Asserts outputs registered, title set, progress hooks called, the error mapping, and that cancellation kills the fake process.
- Optional `integration_test.go` behind `//go:build integration`. It runs real yt-dlp against `https://www.youtube.com/watch?v=jNQXAC9IVRw` into a temp dir. It's not part of the default `go test ./...`.

---

## 8. Frontend

### 8.1 File layout and ownership

```
frontend/
  index.html  package.json  tsconfig.json  vite.config.ts   (foundation)
  bindings/                    generated, committed; ONLY the architect regenerates
  src/
    main.tsx  App.tsx           (foundation)
    styles/                     (WP-E) tokens.css base.css fonts.css index.css
    lib/
      api.ts                    (foundation) re-exports bound services under short names
      events.ts                 (foundation) typed on(name, cb) → unsubscribe
      errors.ts                 (foundation) toAppError
      platform.ts               (foundation) isMac, modKeyLabel ("⌘"/"Ctrl"), revealLabel
      commands.ts               (foundation) command registry + useCommands hook
      shortcuts.ts              (foundation) useShortcut(combo, handler, {when, allowInInputs})
      format.ts                 (WP-E) bytes, durations, relative time, timecode display
      fuzzy.ts                  (WP-F) fuzzy scorer
    state/                      (foundation) bootstrap.ts jobs.ts modules.ts library.ts settings.ts deps.ts ui.ts
    components/                 (WP-E) design-system primitives (§8.5)
    shell/                      (WP-F) Shell, TitleBar, Sidebar, JobTray/*, CommandPalette/*, DropOverlay, GlobalPaste, ViewRouter
    tools/index.ts              (foundation) moduleId → lazy view map
    tools/downloader/           (WP-G) DownloaderView + parts + logic (urls.ts, timecode.ts)
    views/                      (WP-H) LibraryView, SettingsView, ComingSoonView, BootError
```

**tsconfig:** `strict`, `noImplicitAny: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: false`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. Path aliases: `@/*` → `src/*`, `@bindings/*` → `bindings/toolbox/*`.

**Scripts:** `dev`, `build`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `check:any`. `check:any` is a Node script that fails on `: any`, `as any`, `<any>` or `any[]` in `src/**` (excluding tests). `check` runs typecheck, test and check:any.

### 8.2 State (`state/`, foundation; zustand, one store per domain)

- `bootstrap()` loads, in parallel, `Settings.Get`, `Settings.AppInfo`, `Modules.List`, `Jobs.List({limit:200})`, `Deps.List` and `Library.Recent({limit:100})`. It then subscribes to all events and applies the theme. App renders a blank `--bg-app` until bootstrap resolves. On failure it renders `<BootError>` with the error and a Reload button.
- `jobs`: `byId`, `order` (active first, by CreatedAt asc; then finished, by FinishedAt desc), `logs: Record<id, LogLine[]>` (loaded lazily through `Jobs.Logs` when a log panel opens, then appended from events, capped at 5,000 in memory), plus actions that call bindings.
- `modules`: descriptors. `library`: recent outputs plus paging and filters. `settings` and `appInfo`. `deps`.
- `ui`: `view` (string id, default `downloader`), `sidebarCollapsed`, `trayOpen`, `paletteOpen`, `drop: FilesDropped | null`, `handoff: {moduleId, inputs: string[]} | null` (consumed by a tool view on mount), `expandedLogJobId`. `sidebarCollapsed`, `trayOpen` and the last `view` persist in `localStorage`.

### 8.3 Screens and states

**Layout** (min window 960×600, default 1180×760):

```
┌────────────┬───────────────────────────────────────────────┐
│ ● ● ●      │ View title                      [⌘K Search]   │ ← 44px drag region (mac: traffic lights over sidebar)
│ LIBRARY    ├───────────────────────────────────────────────┤
│  Recent    │                                               │
│ TOOLS      │              active view                      │
│  Downloader│                                               │
│ COMING SOON│                                               │
│  Stems ·   │                                               │
│  …         │                                               │
│            ├───────────────────────────────────────────────┤
│ ⚙ Settings │ ▮▮▮▮▯▯ 2 running · 1 queued        ⌘J  ▴     │ ← job tray strip 36px, expands to 300px
└────────────┴───────────────────────────────────────────────┘
  232px (collapses to 56px icon rail, ⌘\)
```

- **Mac window:** `MacTitleBarHiddenInset`, `InvisibleTitleBarHeight 44`, opaque `BackgroundColour` = dark `--bg-app`. Drag regions use `--wails-draggable: drag`, and interactive children set `no-drag`. **Windows:** standard native frame.
- **Native menu:** AppMenu (with "Settings…" `CmdOrCtrl+,` → emits `app:navigate {target:"settings"}`), EditMenu (**required** for copy and paste in the mac webview) and WindowMenu.

**Sidebar**
- Sections, each with an 11px uppercase label:
  - **LIBRARY**: Recent.
  - **TOOLS**: ready modules.
  - **COMING SOON**: collapsible, collapsed by default, persisted. Items are dimmed with a `SOON` tag, but clickable to the ComingSoon view.
  - Bottom: **Settings**. It shows an amber dot if any required dep is missing, and a red dot if a required dep is in error.
- Items are 30px tall with a 16px lucide icon (stroke 1.75). The active item gets `--bg-active` and a 2px accent notch on the left.
- Collapsed: icon rail with tooltips.

**Downloader view** (WP-G)
- **Header:** title "Downloader", tagline, and the right-aligned destination path chip `~/Toolbox/Downloads` (click to reveal).
- **Dependency banner** (top of the form, from the deps store):
  - yt-dlp missing → "yt-dlp isn't installed" with an **Install yt-dlp** button (`Deps.UpdateYtDlp`). The button shows a spinner while that job runs.
  - ffmpeg or ffprobe missing → "ffmpeg is required for conversion and merging" plus a copyable install hint.
  - deno and node both missing → a subtle warning "YouTube works best with Deno installed" plus the hint.
  - Submit is disabled while any **required** dep is missing, with the reason shown under the button.
- **URL input:** an auto-growing textarea (1–8 rows, mono 12px) with placeholder `Paste one or more links…`. URLs are split on whitespace. Below it, a parsed list of chips shows each URL as host + truncated path with a ✓/✕ and the error on hover. Duplicates collapse with a "×2" note. A count summarises "3 links · 1 invalid".
- **Options panel** (two-column grid at ≥1100px, one column below):
  - **MODE:** segmented control Audio | Video.
  - **FORMAT** (audio): segmented mp3 | wav | flac.
  - **QUALITY** (mp3 only): select Best (V0) / 320 / 256 / 192 / 128 kbps.
  - **MAX RESOLUTION** (video): select Best / 2160p / 1440p / 1080p / 720p / 480p / 360p, with a fixed "MP4" label beside it.
  - **TRIM:** switch. When on, Start and End timecode inputs (mono, counter-styled, placeholders `0:00` and `end`) with inline validation.
  - **EMBED:** switches for Metadata and Thumbnail. Thumbnail is disabled for wav with the hint "Not supported for WAV".
  - **PLAYLIST:** switch "Download the whole playlist when a link is a playlist".
- **Primary button:** `Download 3` (count of valid URLs), with the `⌘↵` hint. On submit it calls `Downloader.Enqueue`.
  - On success: clear the URL input, show the toast "3 downloads queued", and keep the options.
  - On validation error: map `fields` to the inputs and chips.
  - Options are persisted through `Settings.SetModuleState("downloader", json)` on change (debounced 300 ms) and loaded on mount (falling back to `Downloader.Defaults()`).
- **Below the form:**
  - "Active" shows this module's queued and running jobs as compact rows (same component as the tray row).
  - "Recent downloads" shows the last 20 outputs of this module: name, size, relative time, and hover actions Reveal / Open / Copy path.
  - Empty state: "Nothing downloaded yet. Paste a link above, or anywhere in the app."
- **Handoff:** if `ui.handoff.moduleId === "downloader"`, prefill the URLs on mount and focus the button.
- **Commands registered:** "Download as audio", "Download as video" (set the mode and submit), "Focus link input" (`⌘L`).

**Library view** (WP-H): title "Recent".
- Toolbar: search field (`/` focuses it), module filter select, and an "Open library folder" button.
- List rows (32px): kind icon · name · module · size (mono) · relative time (mono) · hover actions Reveal (label from `platform.revealLabel`: "Reveal in Finder" / "Show in Explorer") / Open / Copy path / Remove from library.
- A missing file shows a dimmed row with a `MISSING` badge, and only "Remove from library" is enabled.
- Paging uses "Load more" (cursor) and live inserts from `library:added`.
- Empty state: an icon and "Your outputs will appear here."
- Keyboard: ↑↓ to select, Enter opens, `⌘⇧R` reveals.

**Settings view** (WP-H): sections stack vertically with labels and a max width of 720px.
- **Library:** the current path (mono), **Change…** (`Settings.ChooseLibraryDir` → native directory dialog → `Settings.Update`), and **Open**. Note: "Existing files stay where they are."
- **Jobs:** "Parallel jobs" stepper 1–8.
- **Appearance:** theme segmented System / Dark / Light, which applies instantly.
- **Dependencies:** a table with columns Tool · Status chip (OK green / Missing amber or red if required / Error red) · Version (mono) · Source (managed / PATH / system) · Path (mono, truncated middle, copy button) · Action.
  - Actions: yt-dlp gets **Install** or **Update**; the others get **Copy install command**.
  - A table header button **Recheck** calls `Deps.Recheck`.
  - Each row has "Required by Downloader" or "Recommended" metadata in subtle text.
- **About:** version, OS/arch, support dir (Open), database path, log file (Open).

**Coming soon view** (WP-H): the large module icon, name, tagline, description, an "Accepts" list of extensions as chips, and the line "Planned for a future phase." Calm and centered.

**Job tray** (WP-F)
- **Strip** (always visible, 36px):
  - an aggregate segmented meter (the mean progress of running jobs, or indeterminate if any job is indeterminate)
  - the text `2 running · 1 queued` (or `Idle`, or `3 done`), plus a failed count in red if > 0
  - the `⌘J` hint and a chevron
  - clicking toggles the tray.
- **Expanded** (300px, resizable 200–60% of height by dragging the top edge, size persisted):
  - Header: counts, **Clear finished**, collapse.
  - Rows: module icon · title (or the first input) · status chip · meter (80px) · message (mono 11px, muted) · elapsed or finished time · actions:
    - running or queued: **Cancel** (✕)
    - failed or cancelled: **Retry** (↻)
    - done with outputs: **Reveal** (first output)
    - finished: **Remove** (hover)
    - all: chevron to expand logs.
  - A row shows "Cancelling…" while `cancelRequested`.
  - A failed row shows the error message in `--danger` and the hint below it in muted text.
- **Log panel** (inline under the row, 220px):
  - Mono 11.5px, stderr lines tinted `--warn`, system lines `--fg-subtle` italic.
  - Auto-scrolls only when already at the bottom. A "Jump to latest" pill appears otherwise.
  - Renders the last 1,000 lines with "Show all N lines" to expand.
  - **Copy** button.
- Empty state: "No jobs yet. Paste a link anywhere to start a download."
- **Toasts:** when a job fails while the tray is collapsed, the toast "Download failed: <title>" with a **Show** action (opens the tray and expands the row). When a job is done while the tray is collapsed, the toast "Saved <name>" with **Reveal**. Toasts are bottom-right above the strip, auto-dismiss after 5 s, and pause on hover.

**Global drag and drop** (WP-F)
- The shell root has `data-file-drop-target`.
- With the CSS class `file-drop-target-active` present, a full-window overlay fades in (120 ms): a 1px dashed `--line-strong` inset at 12px with the centered text "Drop files to see which tools can use them".
- On `app:files-dropped`, the overlay becomes a **chooser panel** (centered, 520px):
  - the file count, plus the first 3 names in mono
  - matches as rows: icon, name, which files match, and status. Ready → clickable: sets `handoff` and navigates. Coming soon → disabled with a `SOON` tag.
  - an "Unsupported: x.zip, folder/" line for unmatched paths.
  - Esc or a backdrop click closes it.
  - Zero matches → "No tool accepts these files yet."
- In Phase 1 every file match is "coming soon". This is expected and demonstrates the registry.

**Global paste** (WP-F): on `paste` when focus isn't in an editable element, any http(s) URLs in the clipboard text set `handoff {moduleId:"downloader", inputs}` and navigate to the downloader.

**Command palette** (WP-F), opened with `⌘K` / `Ctrl+K`
- Centered at 18vh, 600px wide, with an input and grouped results:
  - **Navigate:** every non-hidden module, Recent, Settings
  - **Actions:** registered commands
  - **Recent outputs:** the top 5 matching names, which open the file, or reveal it with `⌘↵`.
- Fuzzy subsequence scoring (`lib/fuzzy.ts`) with bonuses for word starts and consecutive runs, and a penalty for gaps. Max 50 results. Matched characters are highlighted.
- ↑↓ / Ctrl-N / Ctrl-P move, Enter runs, Esc closes. Shortcut hints are shown right-aligned as `<Kbd>`.
- Built-in commands:
  - Go to Recent / Settings / each tool
  - Toggle job tray
  - Toggle sidebar
  - Cancel all jobs
  - Clear finished jobs
  - Theme: Dark / Light / System
  - Open library folder
  - Install/Update yt-dlp
  - Recheck dependencies
  - Paste link and download

**Keyboard map** (`Mod` = ⌘ on mac, Ctrl on Windows):

| Keys | Action |
|---|---|
| `Mod+K` | palette |
| `Mod+1…9` | sidebar items in visible order |
| `Mod+,` | settings |
| `Mod+J` | tray |
| `Mod+\` | sidebar collapse |
| `Mod+Enter` | submit the current tool |
| `Mod+L` | focus the downloader link input |
| `Esc` | closes the topmost overlay (palette > drop chooser > expanded log) |
| `/` | focuses search in Library |

Shortcuts are ignored inside text inputs unless `allowInInputs` is set (only `Mod+K`, `Mod+Enter` and `Esc` allow it).

### 8.4 Design direction ("Console")

The intent is pro creative software: a DAW mixer's calm density crossed with a modern Mac utility. Surfaces separate by small tonal steps and hairlines, not by shadows. One warm signal colour. Numbers always in a monospace with tabular figures. Labels read like hardware panel silkscreen.

**Typography** (bundled through fontsource, no network)
- UI: **Geist Variable**. Mono: **Geist Mono Variable** for logs, timecodes, sizes, percentages and paths.
- Global `font-feature-settings: "tnum"` on mono, `"cv11"` off.
- Scale (size/line-height, weight):
  - `--text-xs` 11/16 — labels: 500, uppercase, `letter-spacing: .06em`, `--fg-subtle`
  - `--text-sm` 12/18
  - `--text-md` 13/20 (base)
  - `--text-lg` 15/22, 600 (section titles)
  - `--text-xl` 20/28, 600, `-0.015em` (view titles)
  - `--text-2xl` 28/34, 600, `-0.02em` (empty and coming-soon heroes)

**Colour tokens** (`styles/tokens.css`). `:root[data-theme="dark"]` is the default. `:root[data-theme="light"]`. `system` resolves through `matchMedia` and sets the attribute.

| Token | Dark | Light |
|---|---|---|
| `--bg-app` | `#0B0C0E` | `#E8E8EB` |
| `--bg-sidebar` | `#0F1012` | `#EEEEF1` |
| `--bg-panel` | `#131417` | `#F7F7F9` |
| `--bg-raised` | `#1A1B1F` | `#FFFFFF` |
| `--bg-hover` | `#212227` | `#EDEDF0` |
| `--bg-active` | `#292B31` | `#E3E3E8` |
| `--bg-inset` (inputs, counters) | `#0D0E10` | `#F0F0F3` |
| `--line` | `rgba(255,255,255,.07)` | `rgba(10,10,20,.08)` |
| `--line-strong` | `rgba(255,255,255,.12)` | `rgba(10,10,20,.15)` |
| `--fg` | `#EDEDEF` | `#121316` |
| `--fg-muted` | `#A1A2AA` | `#55575F` |
| `--fg-subtle` | `#6B6D76` | `#868892` |
| `--fg-faint` | `#45474F` | `#B4B5BC` |
| `--accent` ("signal") | `#FF8C42` | `#DD6416` |
| `--accent-fg` | `#1A0B02` | `#FFFFFF` |
| `--accent-soft` | `rgba(255,140,66,.14)` | `rgba(221,100,22,.12)` |
| `--ok` | `#4ADE80` | `#15803D` |
| `--warn` | `#F5C451` | `#A16207` |
| `--danger` | `#FF5C5C` | `#DC2626` |

Each semantic colour also has a `-soft` variant at about 14 % alpha. Text-on-surface pairs must meet WCAG AA (checked by WP-E with a small contrast unit test over the token table).

**Shape and space**
- 4px grid.
- Control height 28px (compact 24px). List rows 32px. Sidebar items 30px.
- Radii: `--r-sm` 4px (chips), `--r-md` 6px (controls), `--r-lg` 10px (panels and palette).
- Borders are 1px `--line`. Elevation only for popovers and the palette: `0 16px 48px rgba(0,0,0,.45)` plus a 1px `--line-strong` (light: `rgba(20,20,40,.18)`).

**Signature elements**
1. **Segmented meter** (`<Meter>`): a 4px-tall bar made of 3px segments with 1px gaps (a CSS mask with `repeating-linear-gradient`), like a DAW level meter.
   - Fill: `--accent` while running, `--ok` when done (a 600 ms brighten-then-settle), `--danger` when failed, `--fg-faint` when cancelled or queued.
   - Indeterminate: a 30 %-wide lit window sweeps across in 1.2 s linear.
   - Width transition: 100 ms linear.
2. **Silkscreen labels** above form groups: `--text-xs` uppercase.
3. **Counter inputs** for timecodes: `--bg-inset`, mono, centered, with the accent caret.
4. **Status chips**: 18px tall, mono 10.5px uppercase — `QUEUED` (faint), `RUNNING` (accent-soft bg, accent text), `DONE` (ok-soft), `FAILED` (danger-soft), `CANCELLED` (faint).
5. The active sidebar notch and the focus ring: `0 0 0 1px var(--bg-panel), 0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent)`, `:focus-visible` only.

**Motion**
- Hover and press: 120 ms ease-out.
- Panels and tray: 180 ms `cubic-bezier(.2,.8,.2,1)`.
- Palette in: 120 ms opacity plus `translateY(4px)` and `scale(.985)` → identity.
- No bounce, no spinners longer than necessary (prefer meters).
- `prefers-reduced-motion`: disable transforms and the sweep, keep opacity fades at 80 ms.

**Icons:** lucide-react, 16px, stroke 1.75, `currentColor`. `<Icon name>` uses a **static map** of the names used in the app (tree-shakable); unknown names fall back to `box`.

**Placeholder modules** (`modules/placeholders`, foundation): id · name · icon · accepts.

| ID | Name | Icon | Accepts |
|---|---|---|---|
| `stems` | Stem Splitter | `audio-lines` | audio |
| `bpm-key` | BPM & Key | `activity` | audio |
| `audio-to-midi` | Audio → MIDI | `piano` | audio |
| `converter` | Converter | `repeat` | audio + video + image |
| `bg-remover` | Background Remover | `wand-sparkles` | image |
| `upscaler` | Upscaler | `maximize-2` | image |
| `exif` | EXIF | `scan-search` | image + `.dng .cr2 .cr3 .nef .arw .raf .orf .rw2` |
| `transcribe` | Transcribe | `captions` | audio + video |
| `llm-chat` | Local Chat | `message-square` | — |
| `pdf` | PDF Toolkit | `file-text` | `.pdf` |
| `archiver` | Web Archiver | `archive` | — (URLs false in Phase 1, so paste routing is unambiguous) |
| `vault` | Vault | `lock` | — |
| `clipboard` | Clipboard History | `clipboard` | — |

Each has a tagline and a one-sentence description. If a lucide name doesn't exist in 1.62, use the closest one and note it.

### 8.5 Component inventory (WP-E, `src/components/`, each with `*.module.css`, typed props, no `any`)

- **Controls:** `Button` (variants `primary | secondary | ghost | danger`, sizes `sm | md`, `loading`, `icon`, `kbd` hint), `IconButton` (required `label` for aria and tooltip), `SegmentedControl<T extends string>`, `Select<T extends string>` (native `<select>` restyled), `Switch`, `Stepper`, `TextField`, `TextArea` (autogrow), `TimecodeInput`.
- **Display:** `Field` (label, hint, error, children), `Meter`, `StatusChip`, `Badge`, `Kbd` (renders `Mod` per platform), `Tooltip` (CSS plus a small hook, 400 ms delay), `Banner` (`info | warn | danger`, with an action slot), `EmptyState`, `Spinner` (rare), `Icon`, `PathText` (middle truncation and copy), `Toaster` plus an imperative `toast({title, description?, tone?, action?})`, `Section` (silkscreen label plus content).
- **Future module UIs:** `DropZone`, a local drop zone for future module UIs that uses `data-file-drop-target` with its own id, and `FileList`.
- A `components/index.ts` barrel.
- A dev-only `src/components/Gallery.tsx` that renders every component in both themes, reachable via palette command "Component gallery" only when `import.meta.env.DEV`.

---

## 9. Bound API (`api/`, foundation writes signatures and delegating bodies)

All services use `ServiceOptions{MarshalError: MarshalError}`. Methods taking `ctx context.Context` first are cancellable from JS.

```go
// api/modules.go — ModulesService
List() []core.Descriptor
Match(paths []string) core.MatchResult

// api/jobs.go — JobsService (wraps *core.Jobs)
List(f core.JobFilter) ([]core.Job, error)
Get(id string) (core.Job, error)
Cancel(id string) error
CancelAll() error
Retry(id string) (core.Job, error)
Remove(id string) error
ClearFinished() (int, error)
Logs(id string) ([]core.LogLine, error)

// api/library.go — LibraryService
Recent(q core.OutputQuery) (core.OutputPage, error)
Reveal(outputID string) error          // app.Env.OpenFileManager(path, true); missing → not_found
Open(outputID string) error            // app.Browser.OpenFile(path)
RevealPath(path string) error          // must be inside library or support dir; dir → open dir
Remove(outputID string) error          // DB only; emits library:removed
OpenLibraryFolder(subdir string) error // "" = root; creates if missing

// api/settings.go — SettingsService
Get() core.Settings
Update(p core.SettingsPatch) (core.Settings, error)
ChooseLibraryDir() (string, error)     // native dir dialog; "" if cancelled (not an error)
ModuleState(moduleID string) (string, error)
SetModuleState(moduleID, stateJSON string) error
AppInfo() core.AppInfo

// api/deps.go — DepsService
List() []core.DepStatus
Recheck(ctx context.Context) ([]core.DepStatus, error)
UpdateYtDlp() (core.Job, error)        // conflict if yt-dlp users active

// modules/downloader/service.go — downloader.Service (bound directly)
Defaults() downloader.Options
Enqueue(urls []string, opts downloader.Options) ([]core.Job, error)
```

`main.go` wiring order:
1. paths
2. logger
3. `store.Open` (with migration)
4. `SettingsService`
5. ensure library dir (on failure, log and continue; jobs that need an output dir fail with a clear `validation` error "Library folder unavailable: <path>")
6. `Registry`
7. `deps.New`
8. `core.NewJobs(…)`
9. register the downloader, placeholders and ytdlp-update module
10. `jobs.Start(ctx)` (recovery)
11. `go deps.Detect`
12. Wails app (services, menu, `SingleInstance`)
13. main window (`EnableFileDrop`, the drop handler → `registry.Match` → emit)
14. the settings `OnChange` hook → `jobs.SetConcurrency`
15. `app.Run()`

`core.Jobs` (WP-B, signatures fixed in foundation):

```go
func NewJobs(store JobStore, outputs OutputStore, reg *Registry, em Emitter, tools func(string) (string, error), settings func() Settings, supportTmp string) *Jobs
func (m *Jobs) Start(ctx context.Context) error
func (m *Jobs) Shutdown(timeout time.Duration) error
func (m *Jobs) Submit(ctx context.Context, moduleID string, inputs []string, optionsJSON string) ([]Job, error)
func (m *Jobs) List(ctx context.Context, f JobFilter) ([]Job, error)
func (m *Jobs) Get(ctx context.Context, id string) (Job, error)
func (m *Jobs) Cancel(id string) error
func (m *Jobs) CancelAll()
func (m *Jobs) Retry(ctx context.Context, id string) (Job, error)
func (m *Jobs) Remove(ctx context.Context, id string) error
func (m *Jobs) ClearFinished(ctx context.Context) (int, error)
func (m *Jobs) Logs(ctx context.Context, id string) ([]LogLine, error)
func (m *Jobs) SetConcurrency(n int)
func (m *Jobs) HasActive(moduleIDs ...string) bool
```

---

## 10. Repo layout (final state of Phase 1)

```
.claude/agents/builder.md   .claude/settings.json
.gitignore                  (bin/, build/bin/, frontend/node_modules/, frontend/dist/, .dev/, .claude/worktrees/, .claude/settings.local.json, *.db)
CLAUDE.md  SPEC.md  README.md (short: what it is, how to run)
Taskfile.yml  build/  (from wails3 init; app name "Toolbox", bundle id dev.toolbox.app)
go.mod  go.sum  main.go  menu.go
api/        services.go modules.go jobs.go library.go settings.go deps.go events.go errors.go
core/       module.go types.go errors.go events.go interfaces.go paths.go registry.go
            jobcontext.go jobs.go throttle.go settings.go version.go  (+ *_test.go)
core/proc/  proc.go proc_unix.go proc_windows.go proc_test.go
core/store/ db.go migrate.go jobs.go outputs.go settings.go migrations/0001_init.sql (+ tests)
core/deps/  catalog.go deps.go detect.go ytdlp_update.go (+ tests, testdata)
modules/downloader/   module.go options.go validate.go args.go progress.go run.go service.go (+ tests, testdata/)
modules/placeholders/ placeholders.go
sidecar/README.md
docs/DECISIONS.md
frontend/ … (§8.1)
```

`.dev/` (gitignored) is the sandbox for local runs: `TOOLBOX_SUPPORT_DIR=.dev/support TOOLBOX_LIBRARY_DIR=.dev/library`. A `Taskfile` task `dev:sandbox` sets both and runs `wails3 dev`.

---

## 11. Test plan

### 11.1 Go (`go test ./...`, plus `go vet ./...`, plus `gofmt -l` is empty)

- **core/registry:** register, duplicate, placeholder can't `Get`, `List` ordering, `Match` case-insensitivity, directories go to unmatched, `RequiringDep`.
- **core/jobcontext:** `DecodeOptions` rejects unknown fields; the hooks are invoked.
- **core/jobs** (fake store in memory plus a fake module whose behaviour is scripted through channels):
  - FIFO order
  - the concurrency limit is respected (never more than N in Run at once, checked with an atomic counter)
  - `SetConcurrency` up and down
  - per-module `MaxConcurrent` doesn't block other modules
  - cancel queued
  - cancel running → `cancelled` even when Run returns an error
  - Run panic → `failed/internal`
  - retry increments attempt and keeps outputs
  - retry on running → conflict
  - remove running → conflict
  - ClearFinished count
  - startup recovery (running → interrupted, queued → resumed)
  - `Shutdown` cancels and waits
  - the `TempDir` is removed in all outcomes
  - the progress-monotonic clamp
  - the log cap of 10,000 plus the truncation marker
  - `SplitInputs` creates N jobs
  - validation errors create no jobs
  - all with `-race`.
- **core/throttle:** coalescing (≤ 1 per 100 ms, trailing value delivered) using an injected clock.
- **core/store:** run against a real SQLite in `t.TempDir()`:
  - migrations are idempotent
  - job CRUD round trip, including Outputs population
  - logs append and order
  - the cascade on job delete
  - output upsert keeps the ID
  - `job_id` is set NULL when its job is deleted
  - cursor paging is stable across inserts
  - search
  - `Missing` is computed
  - the settings get/set round trip.
- **core/settings:** defaults written on first run; validation (relative path, not writable, inside the support dir, concurrency bounds, bad theme); `OnChange` fires.
- **core/proc:** a line splitter that handles `\r` progress lines and partial final lines; cancel kills the process tree (helper re-exec); exit code capture; stderr tail.
- **core/deps:**
  - version regexes against sample outputs
  - resolution order (managed > PATH > known dir) using temp dirs with fake executables
  - asset selection per GOOS/GOARCH
  - the update flow against `httptest.Server`: up to date, fresh install, checksum mismatch, cancel mid-download, oversize
  - Windows-only test for the `.exe` suffix (build tag).
- **modules/downloader:** see §7.7.

### 11.2 Frontend (`npm run check`)

- `vitest` with jsdom.
  - Pure-logic tests: `fuzzy.ts` ranking, `format.ts` (bytes, durations, relative time), `tools/downloader/urls.ts` (split, dedupe, validation), `timecode.ts` (same grammar cases as Go), the token contrast check.
  - Component tests (Testing Library): `Meter` states, `SegmentedControl` keyboard nav, the `JobRow` actions per status, and `CommandPalette` filtering and Enter.
- Bindings are mocked in tests with `vi.mock("@bindings/…")`.
- `tsc --noEmit` is clean. `check:any` is clean.

### 11.3 Manual smoke checklist (the architect runs it on Windows during integration; you run it on the Mac)

Run `task dev:sandbox`. Then confirm:

1. The app opens with the dark theme, the sidebar, the Downloader view and an idle tray.
2. Settings → Dependencies shows ffmpeg OK and yt-dlp missing. **Install yt-dlp** runs as a job with progress, and afterwards the status is OK with source managed.
3. Paste `https://www.youtube.com/watch?v=jNQXAC9IVRw` anywhere → the Downloader is prefilled. Download as mp3 320 → real progress → the file is in `.dev/library/Downloads` with the title tag and cover art embedded (checked with `ffprobe`).
4. The same URL as video at 720p with a 0:05–0:12 trim produces a ~7 s mp4.
5. Start a download and cancel it mid-way → status cancelled, no `yt-dlp`/`ffmpeg` processes left (Task Manager / `ps`), TempDir gone.
6. An invalid URL plus a valid one → the invalid chip is flagged and only 1 job is submitted.
7. Quit during a download, relaunch → that job is failed "Interrupted". Retry works.
8. Recent view lists the outputs. Reveal opens Explorer/Finder with the file selected. Deleting the file on disk → the row shows MISSING.
9. Drop a `.mp3` from Explorer → the chooser shows Stem Splitter, BPM & Key and the others as SOON.
10. `Mod+K` palette navigation and commands work. Theme switching works. Concurrency 1 runs jobs strictly one at a time.
11. A production `wails3 build` launched with downloads running → `netstat -ano | findstr <pid>` (win) / `lsof -nP -iTCP -a -p <pid>` (mac) shows **no LISTEN sockets**.

---

## 12. Execution plan and work packages

### 12.1 Toolchain (architect, first)

On this Windows machine:
- `winget install GoLang.Go` (1.27.x)
- `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0`
- **Upgrade Node to 24 LTS:** `winget install OpenJS.NodeJS.LTS`. This is required because Vite 8 needs Node ≥ 20.19 and Vitest 5 needs ≥ 22.12. *This changes the global Node used by your other repos. If you'd rather not, edit this line to: "install fnm via winget and pin Node 24 for this repo with `.node-version`".*
- `wails3 doctor` must pass.
- yt-dlp is not installed globally. The app installs it into its own support dir (sandboxed under `.dev/` during dev).

On the Mac later: `brew install go node ffmpeg deno`, then the same `go install`.

### 12.2 Wave 0 — Foundation (architect, sequential, committed to `main`)

The repo has no commits yet. The first commit is `.claude/`, `SPEC.md`, `.gitignore`. Then, in small commits:

1. **Scaffold:** `wails3 init -n toolbox -t react` in a temp dir inside the repo (`.dev/scaffold`), then move the files into the repo root. Remove the greet demo. App name "Toolbox". Upgrade the frontend deps per §3. tsconfig per §8.1. vitest config. The `check:any` script. The fonts.
2. **Go contracts, complete:**
   - `core/module.go`, `types.go`, `errors.go`, `events.go`, `interfaces.go`, `paths.go`, `version.go`, `registry.go` (+ tests), `jobcontext.go` (+ tests)
   - `core/proc` (+ tests)
   - `modules/placeholders`
3. **Go stubs with final exported signatures** that return `Errorf(CodeNotImplemented, …)`:
   - `core/jobs.go`, `core/throttle.go`, `core/settings.go`
   - `core/store/*`, `core/deps/*`
   - `modules/downloader/*` (exported types and options complete; logic stubbed)
4. **`api/` complete** (thin delegations) and **`main.go`/`menu.go` complete**. It compiles and the window opens. Bindings are generated and committed.
5. **Frontend contracts:**
   - `lib/` (foundation files)
   - `state/`
   - `tools/index.ts`
   - `App.tsx`, `main.tsx`
   - stub components for every WP-owned entry point (`Shell`, views, `DownloaderView`, `styles/index.css`), each exporting the final name and props type. `npm run check` passes.
6. **Docs:** `CLAUDE.md`, `docs/DECISIONS.md` (seeded with this spec's decisions), `sidecar/README.md`, `README.md`.

### 12.3 Wave 1 — five builders in parallel (each in its own worktree branched from foundation `main`)

| WP | Owns (exclusive) | Consumes | Acceptance |
|---|---|---|---|
| **A. Store and settings** | `core/store/**`, `core/settings.go`, `core/settings_test.go` | `core` interfaces and types | All §11.1 store and settings tests pass. `store.DB` satisfies all three interfaces (compile-time assertions). |
| **B. Jobs engine** | `core/jobs.go`, `core/jobs_test.go`, `core/throttle.go`, `core/throttle_test.go`, `core/fakes_test.go` | `Registry`, `JobContext`, interfaces | All §11.1 jobs and throttle tests pass with `-race`, 20× in a row (`-count=20`). |
| **C. Deps** | `core/deps/**` | `core`, `core/proc`, `Registry` | §6.3 behaviour. All §11.1 deps tests pass. No real network in tests. |
| **D. Downloader backend** | `modules/downloader/**` | `core`, `core/proc` | §7 behaviour. All §7.7 tests pass. Fixtures present. |
| **E. Design system** | `frontend/src/styles/**`, `frontend/src/components/**`, `frontend/src/lib/format.ts` (+ tests) | tokens §8.4 | Every §8.5 component exists, typed, in both themes, with the Gallery. Tests pass. `npm run check` passes. |

### 12.4 Wave 2 — three builders in parallel, after E is merged (A–D may still be in flight; the UI codes against the bindings)

| WP | Owns (exclusive) | Acceptance |
|---|---|---|
| **F. Shell** | `frontend/src/shell/**`, `frontend/src/lib/fuzzy.ts` (+ tests) | Sidebar, tray and logs, palette, drop overlay and chooser, global paste, toasts wiring, and the keyboard map, all per §8.3. Component tests pass. |
| **G. Downloader UI** | `frontend/src/tools/downloader/**` | The §8.3 Downloader view, all states, including the deps banner, validation mirroring, persisted options and handoff. Logic tests pass. |
| **H. Views** | `frontend/src/views/**` | Library, Settings, ComingSoon and BootError per §8.3. |

### 12.5 Wave 3 — Integration (architect)

1. Merge in dependency order: A, B, C, D, E, then F, G, H. Review each against the spec before merging.
2. Regenerate bindings and run the full checks: `go build ./... && go vet ./... && go test -race ./... && cd frontend && npm run check`.
3. `wails3 build`.
4. Run the §11.3 smoke checklist (steps that need Mac-only behaviour are marked for you).
5. Fix problems, or send a large one back to its builder. Update DECISIONS.md and give the final summary.

**Builder brief template** (what each builder receives):
- the package section(s) of this spec
- the files it owns (exclusive)
- the interfaces it consumes or provides (with file paths)
- its acceptance criteria
- these rules:
  - "Don't change exported signatures in foundation files; if one is wrong, stop and report."
  - "Don't regenerate bindings."
  - "Commit small, never push."

---

## 13. Acceptance criteria (Phase 1 as a whole)

1. `wails3 dev` launches the app on Windows. Its macOS path is implemented per spec.
2. `wails3 build` produces a working binary. It opens no listening sockets (§11.3 #11).
3. `go vet`, `go test -race ./...`, `gofmt` and `npm run check` are all clean on `main`.
4. Every item of the Phase 1 scope in the brief works per §11.3:
   - scaffold
   - core (registry, jobs, SQLite library, deps)
   - Downloader (multi-URL, audio and video, quality and resolution, trim, metadata and thumbnail, real %, outputs to `<library>/Downloads`)
   - shell (sidebar with coming soon, tray with progress, cancel and logs, global drop, recent outputs with reveal, settings with library folder, concurrency, deps and update yt-dlp)
5. No `any` at module boundaries (`check:any`). No hand-written fetch layer. No telemetry.
6. `CLAUDE.md` contains the architecture, the module contract, "How to add a module" (a step-by-step with file paths), and the workflow, autonomy and safety rules verbatim from the brief.
7. `docs/DECISIONS.md` records every deviation and every ambiguity resolved during the build.
8. Everything is committed on `main` in small commits. Nothing is pushed.

## 14. Known risks and limits

- **Mac-specific behaviour is built on Windows and verified by you:** hidden-inset titlebar, Finder reveal, Homebrew known-dir resolution, the mac yt-dlp asset, and the mac Edit menu. The architect can't run macOS here.
- **YouTube changes often.** Failures that "Update yt-dlp" fixes are expected. Deno is strongly recommended.
- **Progress fixtures are hand-authored** until yt-dlp is installed during integration. Then the architect captures one real transcript per mode into `testdata/` and re-runs the tests.
- TypeScript 7 is new. There's a fallback rule in §3.
