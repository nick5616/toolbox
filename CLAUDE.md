# Toolbox — repo rules and architecture

Personal, local-only desktop app (Wails v3 + Go + React/TS) that wraps open-source media/AI/utility tools behind one UI. Never distributed or hosted. Primary machine: macOS on Apple Silicon; secondary: Windows.

`SPEC.md` is the source of truth for the current phase. `docs/DECISIONS.md` records every deviation and every ambiguity resolved.

---

## How we work

### Roles
- You (Opus, this session) are the architect and orchestrator. You write specs, split work, review, integrate, and fix.
- Implementation is done by `builder` subagents (Sonnet, defined in .claude/agents/builder.md), each in its own git worktree. Do not hand-write large features yourself; delegate them.

### Workflow
1. SPEC: Write SPEC.md for the current phase. It must be complete enough that builders never need to ask anything: goals, non-goals, architecture, interfaces and types, data schemas, file layout, UI screens and states, error handling, test plan, acceptance criteria, and a list of work packages.
2. STOP: After writing SPEC.md, stop and tell me it's ready. This is the ONLY point where you wait for me. I will review it thoroughly and edit it directly.
3. APPROVAL: When I say "approved", SPEC.md is my will. From then on, do not ask me anything. Execute end to end.
4. PARALLEL BUILD:
   - Do the shared foundation yourself first, sequentially, and commit it to main: scaffold, shared types/interfaces, core contracts, CLAUDE.md. Builders branch from this.
   - Split the rest into work packages with explicit, non-overlapping file ownership. Packages with no dependency on each other run in parallel; spawn as many builders at once as the dependency graph allows. Dependent packages wait for their prerequisites to be merged.
   - Give each builder: its package section from SPEC.md, the files it owns, interfaces it must consume or provide, and its acceptance criteria.
5. INTEGRATE: As builders finish, review their work against SPEC.md, merge their branches into main locally (resolve conflicts yourself), run the full build and test suite, and fix anything broken. Send a builder back to fix its own package if the problem is large.
6. FINISH: Everything ends up committed on main. Then give me a summary: what was built, how to run it, deviations from the spec, open issues, and a proposed next phase.

### Autonomy rules
- Never ask for confirmation after approval. When the spec is silent or ambiguous, choose the option most consistent with its intent, record it in docs/DECISIONS.md (date, decision, why), and keep going.
- If something is truly blocked (a tool can't be installed, an API doesn't exist), work around it, stub it cleanly behind its interface, log it in DECISIONS.md, and continue with everything else.
- Only stop early for something destructive or irreversible outside this repo.

### Safety rules (we run in bypass permissions mode, so these are strict)
- Never modify, delete, or create files outside this repository, except: installing dev tools via Homebrew/go/npm/uv, and the app's own support directory.
- Never `git push`, never change git remotes, never rewrite main's history (no force, no rebase of main).
- No `sudo`. No `rm -rf` on any path outside the repo. Never touch ~/.ssh, keychains, shell profiles, or other projects.
- Never commit secrets, tokens, or personal files.

### App rules
- No network listeners. Open no ports. If a local server ever becomes unavoidable, bind 127.0.0.1 only with a random per-launch token. **Never build with the Wails `server` or `mcp` build tags** (they are the only code paths in Wails that listen).
- No telemetry or analytics. No outbound calls except what the tools themselves need and dependency updates the user triggers.
- User files live in a configurable library folder (default ~/Toolbox). Never modify input files in place.
- Long operations are cancellable and never block the UI.

---

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| Go | ≥ 1.27 | `go.mod` says `go 1.27` |
| wails3 | v3.0.0 | `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0`; check with `wails3 doctor` (never `wails3 setup`, it's interactive) |
| Node | ≥ 22.12 (24 LTS used) | Vitest 5 requires it |

On the Windows dev box, Go lives in `%LOCALAPPDATA%\Programs\go1.27.3` and Node 24 comes from `fnm` — put both on PATH for a shell:
`export PATH="$APPDATA/fnm/node-versions/v24.22.1/installation:$LOCALAPPDATA/Programs/go1.27.3/go/bin:$HOME/go/bin:$PATH"`.

### Commands

```sh
wails3 task dev:sandbox     # wails3 dev with support/library dirs under .dev/ (preferred)
TOOLBOX_VIEW=settings ...   # optional: open on a view (library, settings, or a module id)
TOOLBOX_SHOW_POPUP=1 ...    # optional: open the clipboard popup 2 s after start (visual QA)
wails3 dev                  # dev against the real support dir and ~/Toolbox
wails3 build                # production binary in bin/
wails3 generate bindings -clean=true -ts -i   # regenerate frontend/bindings (architect only)

go build ./... && go vet ./... && go test -race ./...   # backend checks (-race needs cgo; omit on Windows without a C toolchain)
go test -tags integration ./integration/ ./modules/downloader/ ./modules/converter/ ./modules/exif/ ./modules/upscale/  # real tools + network (upscale needs a Vulkan GPU, else skips)
TOOLBOX_PDF_SAMPLES=1 go test -run TestSamples -v ./modules/pdf/   # every PDF action on the research PDFs in .dev/p4-research/pdf/inputs
go run ./build/icongen/main.go && wails3 task common:generate:icons  # regenerate app/tray icons from the shapes in build/icongen
TOOLBOX_ENGINE_E2E=1 go test -tags integration -run TestEndToEndAudioEngine -timeout 40m ./integration/  # fresh engine install + all engine tools
gofmt -l .                                             # must print nothing
cd frontend && npm run check                           # typecheck + vitest + check:any
```

`frontend/bindings/` is generated and committed. **Only the architect regenerates it** (after merging Go signature changes). Builders never edit it.

---

## Architecture

```
frontend (React, TS strict)          shell/ tools/<module>/ views/ components/ state/ lib/
   │ generated TS bindings (calls) + typed Wails events
api/       thin Wails services; error marshalling; event registration      (Wails allowed)
desktop/   tray, close-to-tray, login item, global hotkeys, popup window   (Wails allowed)
core/      registry · jobs · jobcontext · errors · types · events · paths · settings
core/proc  subprocess runner with whole-tree kill and hidden windows
core/store SQLite (modernc.org/sqlite, no CGO): jobs, logs, outputs, tags, settings
core/deps  external tool detection + managed installs (yt-dlp, uv, ExifTool + upscaler archives)
core/imaging  pure-Go image sizes + scaled previews (jpg/png/gif/webp/bmp/tiff; no HEIC)
modules/   one folder per module (downloader, placeholders, …)
sidecar/   Python "AI engine" (stems, BPM/key, MIDI, transcription, background removal, CPU upscaling, HEIC decoding) over stdio JSON lines
```

Rules:
- `core/**` never imports Wails or `modules/**`. Modules import `core`. Only `main.go`, `api/` and `desktop/` import Wails.
- The UI only knows **modules**, **jobs**, **outputs**, **deps** and **settings** — never which binary or language does the work.
- Every slow operation is a **Job**. Every subprocess goes through `core/proc`.
- All user-facing errors are `*core.AppError` (`code`, `message`, `hint`, `fields`). Wrap everything else with `fmt.Errorf("doing x: %w", err)`.
- Go returns non-nil slices where possible, but generated TS types are `T[] | null`; the `state/` layer normalises them (`normalizeJob`, etc.).
- Times on the wire are Unix milliseconds (`int64`, 0 = unset).

### Module contract (`core/module.go`, `core/jobcontext.go`)

```go
type Module interface {
    Descriptor() core.Descriptor                         // id, name, icon, accepts, requires, outputSubdir, …
    Validate(inputs []string, options json.RawMessage) error // sync, at submit; return core.ValidationError(...)
    Run(ctx context.Context, job *core.JobContext) error     // honour ctx; report via job
}

// JobContext gives Run: ID, Inputs, Options (raw JSON), Attempt, OutputDir, TempDir and
//   job.Progress(pct 0..1 | core.IndeterminateProgress, msg)
//   job.Log(stream, line) / job.Logf(...)
//   job.SetTitle(title)
//   job.Output(path) (core.Output, error)   // registers a finished file in the library
//   job.Tool(depID) (path, error)           // resolves yt-dlp/ffmpeg/… or CodeDependencyMissing
// core.DecodeOptions[T](job) decodes options strictly.
```

The job manager creates `OutputDir` and `TempDir` before `Run`, deletes `TempDir` after, maps the returned error to job status, throttles progress, batches logs, and persists everything.

---

## How to add a module

1. **Backend** — create `modules/<id>/`:
   - `options.go`: an exported `Options` struct (+ typed string enums) and `DefaultOptions()`.
   - `module.go`: a `Module` type implementing `core.Module`, a `const ModuleID = "<id>"`, and `func Register(reg *core.Registry, …) error`. Fill in the `Descriptor` (icon is a lucide name; `Requires` lists dep IDs from `core/deps`; set `OutputSubdir`).
   - `service.go`: a typed Wails service with `Defaults() Options` and `Enqueue(inputs []string, opts Options) ([]core.Job, error)` that marshals opts and calls `jobs.Submit`. This keeps option types in the TS bindings (no `any`).
   - Tests next to the code (pure logic table-tested; `Run` tested against a fake tool via the re-exec helper pattern).
   - If it needs a new external tool, add a `Spec` to `core/deps` catalog.
2. **Wire it** in `main.go`: call `<id>.Register(reg, …)` and add `application.NewServiceWithOptions(<id>.NewService(jobs), opts)` to `Services`. If it was a placeholder, delete its entry in `modules/placeholders`.
3. **Regenerate bindings**: `wails3 generate bindings -clean=true -ts -i`. Re-export the service and option types from `frontend/src/lib/api.ts`.
4. **Frontend** — create `frontend/src/tools/<id>/<Name>View.tsx` (default export, props `ToolViewProps`) and add one line to `frontend/src/tools/index.ts`. Use `components/` primitives, `useCommands` for palette entries, `useUI().takeHandoff(id)` to receive dropped/pasted inputs, and `SettingsService.SetModuleState` to remember options.
5. Run all checks; add a DECISIONS.md entry if anything diverged from the spec.

---

## AI engine (Python sidecar)

The audio tools, transcription, background removal, CPU upscaling and HEIC decoding run on a local Python 3.12 engine managed by **uv**. Full design: `docs/specs/phase-2.md` §4. Users see it as **"AI engine"**; in code it is still `sidecar.DepID = "audio-engine"` (renaming the ID would churn stored state).

- **Source:** `sidecar/` (pyproject + `uv.lock` + `toolbox_sidecar/`). Go embeds it (`sidecar/embed.go`, package `sidecarfiles`, `Hash()`); the app writes it into `<support>/sidecar/` and runs `uv sync --frozen --no-dev` there. Changing any embedded file changes the hash, so installed engines show as **outdated** until the user clicks Update.
- **Paths:** venv `<support>/sidecar/.venv`, CPython `<support>/python`, models `<support>/models`, numba cache `<support>/cache/numba`. Nothing goes to `/tmp`, `~/.cache` or the home dir.
- **Protocol:** JSON Lines on stdio only (never HTTP). Requests `{id, method, params}`; events `{id, event: progress|log|output, data}`; exactly one `{id, result}` or `{id, error:{code,message,hint}}`; `$cancel`, `$shutdown`; a `ready` event on start. stdout is protocol-only — Python's `print` goes to stderr.
- **Go side:** `core/sidecar.Manager` (implements `Caller`) starts the engine lazily, multiplexes calls, maps cancellation (`$cancel`, then kill+restart after 3 s), restarts after crashes, stops after 10 idle minutes and recycles after results with `rssBytes` > 3 GiB.
- **Lock changes:** edit `sidecar/pyproject.toml`, then run `uv lock` in `sidecar/` and check `uv.lock` still has `macosx_14_0_arm64` wheels for torch and onnxruntime. Keep `exclude-dependencies`/`override-dependencies` (basic-pitch needs them).
- **Tests:** `cd sidecar && uv run --group dev pytest` (set `UV_CACHE_DIR`/`UV_PYTHON_INSTALL_DIR` to a dir under `.dev/` when running locally). Slow model tests need `TOOLBOX_SLOW=1`.

### How to add a sidecar handler

1. Add `sidecar/toolbox_sidecar/handlers/<area>.py` with `@handler("<area>.<name>")` functions taking `(ctx: Context, params: dict) -> dict`; import the module in `handlers/__init__.py`.
2. Validate params → `raise HandlerError("validation", "…")`; report with `ctx.stage()/ctx.progress()/ctx.log()/ctx.output()`; call `ctx.check_cancelled()` between expensive steps.
3. Add pytest tests with generated signals (see `tests/conftest.py`).
4. In the Go module's `Run`: `job.Tool(sidecar.DepID)` (fails fast with an install hint), then `caller.Call(ctx, "<area>.<name>", params, onEvent)` mapping progress→`job.Progress`, log→`job.Log`, output→`job.Output`; decode the result and `job.SetResult(...)` if the module returns data.
5. New Python deps: add to `pyproject.toml`, `uv lock`, and note the size impact in DECISIONS.md.

## Desktop shell, popup windows and hotkeys (Phase 3)

- `desktop.Shell` (built in `main.go` after the Wails app) owns the tray, the main window's close hook (close → hide when `keepInTray`), start-at-login, global hotkeys and the popup window. The app never quits because a window closed; it quits from the tray menu, Cmd+Q, or closing with `keepInTray` off.
- **Popup windows** load `/?window=popup&view=<id>`; `App.tsx` renders `PopupShell` and `bootstrapPopup()` (settings, modules, desktop state only). Add a popup view in `frontend/src/tools/index.ts` → `popupViews`. Each window is its own JS context; Go events reach every window.
- **Adding a global hotkey:** add an action constant + default in `core` (`HotkeyActions`, `DefaultHotkeys`), handle it in `desktop` (hotkey manager action table), and give it a label in Settings → General. Accelerators use Wails syntax (`CmdOrCtrl+Alt+V`) and must include CmdOrCtrl/Ctrl/Alt/Super (`core.CanonicalAccelerator`). Registration failures are reported via `hotkeys:status`, never fatal.

## Clipboard history privacy rules

- Recording is **off by default** and only starts when the user enables it; the tray and the tool header always show whether it is recording.
- Never store copies marked sensitive by the OS/password managers (`Data.Sensitive`); skip text > 1 MiB and images > 20 MB.
- History lives only in the app DB (`clip_items`) and `<support>/clipboard/*.png`; deleting/clearing/pruning removes the image files too. Nothing leaves the machine.
- The app sends a keystroke **only** for opt-in auto-paste: exactly one paste chord (Ctrl+V / Cmd+V) after the user picks an item in the popup with `clipboard.autoPaste` on, into the app that was focused before the popup opened. Never otherwise.
- **Automated checks must not disturb the user's clipboard:** write only test strings you created, read the previous text first and restore it afterwards. No keystroke injection.

## Image tools and PDF Toolkit (Phase 4)

- **Previews:** use `FilesService.ImageThumb(path, maxDim)` (cached, bounded, works for huge outputs) for thumbnails; `ImageDataURL` only for small originals. HEIC has no Go decoder — show a file-type tile.
- **Upscaler:** `upscayl-bin` (AGPL-3.0) is only ever run as a separate process; its install (`<bin>/upscaler/`) is pinned by version + sha256 in `core/deps` (managed archive v2 with a `VERSION` file).
- **PDF:** all PDF work stays in Go. pdfcpu must never write its config dir: `api.DisableConfigDir()` once, and always a `model.NewStatelessConfiguration()`. go-pdfium runs as WebAssembly with **no filesystem mounts** (documents are opened from bytes). Passwords are never stored in job options or the DB — only in the PDF module's in-memory secret store, referenced by `passwordRef`.
- **Engine model downloads** (background removal, CPU upscaling) are verified against pinned sha256 values from the Go presets and live under `<support>/models/{bg,upscale}/`.

## Conventions

- **Go**: idiomatic, context-aware, wrapped errors, stdlib `testing` only (no testify), table tests, `t.TempDir()` for files. No goroutine leaks: everything stops on ctx cancel.
- **TS**: strict + `noUncheckedIndexedAccess`; no `any` in `src/**` (enforced by `npm run check:any`). Import bindings only through `@/lib/api`. Zustand stores in `state/`; selectors must return stable references (use the provided hooks or `useMemo`, never build new arrays inside a selector).
- **CSS**: CSS Modules (`*.module.css`) + tokens from `styles/tokens.css`. No component libraries, no CSS frameworks. Every colour comes from a token.
- **Commits**: small and descriptive, one concern each. Never push.
