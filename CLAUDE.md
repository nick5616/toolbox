# Toolbox — repo rules and architecture

Personal, local-only desktop app (Wails v3 + Go + React/TS) that wraps open-source media/AI/utility tools behind one UI. Never distributed or hosted. Primary machine: Windows; also used on macOS (Apple Silicon). Tools are cross-platform: when something can't be done on one OS, the UI says so and the other OS still gets it.

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
- **Never start a real Focus session while developing.** The Focus engine is in dry run (it decides and logs but never closes or terminates anything) whenever `TOOLBOX_FOCUS_DRYRUN=1`, or `TOOLBOX_SUPPORT_DIR` is set and `TOOLBOX_FOCUS_DRYRUN` isn't `0`. `wails3 task dev:sandbox` and `.dev/p10-qa/dev.sh` set it. Tests use a fake platform; the one real-platform test (`TOOLBOX_FOCUS_E2E=1`) is scoped to processes it spawned.

### App rules
- **No network listeners, with one exception: Local File Transfer** (`core/lan`, `modules/lanshare`; amended 2026-11-04 with the user's approval). It may listen on the local network (TCP and UDP multicast, port 53317 by default) **only while receiving is on**, which only the user turns on. It accepts connections only from private, link-local and Tailscale-range (100.64.0.0/10) addresses, speaks only HTTPS (TLS, self-signed per-install certificate), and writes received files only into `<library>/Received/`. Nothing else in the app listens on a non-loopback address. Any other local server binds 127.0.0.1 only with a random per-launch token.
- **Never build with the Wails `server` or `mcp` build tags** (they are the only code paths in Wails that listen).
- No telemetry or analytics. No outbound calls except what the tools themselves need and dependency updates the user triggers.
- User files live in a configurable library folder (default ~/Toolbox). Never modify input files in place.
- Long operations are cancellable and never block the UI.
- **Toolbox stops other programs only during a Focus session** (`core/focus`, `modules/focus`; approved 2026-11-05). A session is started by the user, directly or by a pipeline they made, and always has an end time (≤ 12 h). During it, Toolbox may close or terminate programs only:
  - in the user's own session (Windows session ID; the user's uid on macOS);
  - never anything in the OS's own folders (`%SystemRoot%`, `/System`, `/usr`, …) or on the frozen Windows extras list;
  - never Toolbox or its descendants;
  - never in a dry run.

  Programs already open when a session starts are only asked to close (WM_CLOSE / the app's own quit); force-closing them needs a click. If the focus engine errors, it stops enforcing (fail-open) and says so.
- **Every program Toolbox launches for the user goes through `core/proc.Launch`** (detached, visible, not tree-killed on cancel). It is the only exception to `core/proc`'s tree-kill rule.

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
TOOLBOX_DEVTOOLS_PORT=9222 ...  # sandbox only: WebView2 DevTools on 127.0.0.1 for automated UI checks (CDP)
TOOLBOX_FOCUS_DRYRUN=1 ...      # Focus Lock decides but never stops programs (set by dev:sandbox; forced by a sandbox support dir)
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
core/deps  external tool detection + managed installs (yt-dlp, uv, ExifTool, upscaler, FFmpeg, Deno, llama.cpp)
core/packs tool packs: catalog, status, install/remove, tools-folder move
core/pipeline Runner: pipelines, runs (items × steps), manual/check pauses, watch folders
core/pdfium shared PDF page renderer (go-pdfium WebAssembly, no FS mounts)
core/imaging  pure-Go image sizes + scaled previews (jpg/png/gif/webp/bmp/tiff; no HEIC)
core/media ffprobe probing, keyframes, webview playability, FFmpeg progress, ASS writer, fonts, preview copies
modules/   one folder per module (downloader, placeholders, …)
frontend/src/editor/  the multitrack Video Editor core; tools/edit-studio is the music layer on it (Phase 10)
frontend/src/blocks/  shared building blocks several tools compose (visual designer, Song Map, source grid); never import a tool (Phase 11)
frontend/src/workspace/  defineWorkspace: store-backed panels + preview parts + rail/bars/studio layout for workspace tools (Phase 11)
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

- **Previews:** use `FilesService.ImageThumb(path, maxDim)` (cached, bounded, works for huge outputs, EXIF-oriented) for thumbnails; `ImageDataURL` only for small originals.
- **HEIC:** Go has no decoder, so `core/heic` converts HEIC/HEIF to an upright cached PNG (`<support>/cache/heic/`): FFmpeg stitches the iPhone tile grid (`xstack` over the "Tile Grid" stream group + crop + the display-matrix rotation), and the AI engine's `image.convert` is the fallback. main.go registers it with `imaging.SetHEICConverter`; any code that reads a photo calls `imaging.ToReadable(ctx, path)` first (`imaging.Size`/`Thumbnailer` already do). FFmpeg also ignores EXIF orientation on stills: pre-orient JPEGs with `imaging.Orient` before handing them to FFmpeg.
- **Upscaler:** `upscayl-bin` (AGPL-3.0) is only ever run as a separate process; its install (`<bin>/upscaler/`) is pinned by version + sha256 in `core/deps` (managed archive v2 with a `VERSION` file).
- **PDF:** all PDF work stays in Go. pdfcpu must never write its config dir: `api.DisableConfigDir()` once, and always a `model.NewStatelessConfiguration()`. go-pdfium runs as WebAssembly with **no filesystem mounts** (documents are opened from bytes). Passwords are never stored in job options or the DB — only in the PDF module's in-memory secret store, referenced by `passwordRef`.
- **Engine model downloads** (background removal, CPU upscaling) are verified against pinned sha256 values from the Go presets and live under `<support>/models/{bg,upscale}/`.

## Local Chat, Vault, OCR and tool packs (Phase 5)

- **The chat engine is the app's only listener.** `llama-server` binds `127.0.0.1` only, on a random port (`--port 0`), behind a random per-launch key passed with `--api-key-file` (file in `<support>/tmp`, 0600, deleted once the server is ready). The port is never sent to the UI. Ollama is opt-in, loopback URLs only, and labelled as having no access control.
- **Vault:** the unlocked age identity lives only in Go memory; lock clears it. Adding files copies them (originals untouched). Temporary open copies live in `<support>/tmp/vault-open/` and are wiped on lock and at app start. Never log names, passphrases or keys.
- **OCR models** are sha-verified downloads in `<models>/ocr/`; the engine is always given explicit model paths and never self-downloads.
- **Tool packs** (`core/packs`): the catalog is frozen data with sizes measured on the pinned versions; bump a pin → update its size. Every non-hidden, non-placeholder, non-built-in module belongs to exactly one pack. Model downloads go through `core.ModelProvider`; pack installs run dep installer modules inside one job via `JobContext.Scoped`.
- **Tools folder:** `Paths.ToolsDir` holds `bin/`, `python/`, `sidecar/`, `models/`; the DB, logs, tmp and caches stay in the support dir. It comes from `$TOOLBOX_TOOLS_DIR` or `<support>/tools-location`. Never write tool files outside `ToolsDir`.
- **FFmpeg and Deno** are pinned managed archives with `AllowSystem`: the managed copy wins, a system copy still counts and is never "outdated".

## Media tools (Phase 6)

- **Local media reaches the webview only through `/media/<token>/<name>`**, served by `api.MediaMiddleware` inside Wails' asset handler: **no socket**. Tokens are 128-bit random, held in a 512-entry in-memory LRU, and only `MediaService` creates them. Every response is capped at 4 MiB (the Windows webview buffers whole bodies); range requests answer 206. Never serve a path that didn't come through `MediaService`.
- **Preview copies** (`media-proxy` job, `<support>/cache/media/proxy/`) exist only to play files the webview can't. Tools always read the original for outputs. The media cache is capped at 5 GB, oldest first.
- **Rendered text** (burned-in subtitles, lyric videos) goes through `core/media` ASS files rendered by libass. Write the ASS into the job's TempDir and run FFmpeg with that as its working directory (`ass=subs.ass`), so filtergraphs never contain Windows paths. Fonts come from `media.Fonts()`.
- **`core.TextGenerator`** (implemented by `modules/chat`) is how a tool uses the local chat model. A background completion holds the generation slot for one request at a time; interactive chat has priority. Nothing is stored as a conversation.
- **Model files** for Redact, Object Eraser and voice denoise follow the bgremove pattern: Go pins `{file, url, sha256}`, `FetchModel` calls the engine's `<area>.prefetch`, run handlers get explicit paths and never download.
- **Caches with pruning at start:** `cache/media` (5 GB), `cache/cleanup-preview` (1 day), `cache/lyric-video` (7 days), `cache/redact` (7 days); `tmp/eraser` masks are deleted after each job and at start.

## Visualizer (Phase 7)

- **Rendered video reaches Go over raw messages, never a socket.** The export worker (`frontend/src/viz/worker/`) renders with the same `Engine` as the preview, encodes H.264 with WebCodecs, and the main thread sends `vz1|<token>|<kind>|…` strings with `System.invoke`. `core/viz.RenderBroker` (wired to `application.Options.RawMessageHandler`) accepts a message only with an active render's token from the app's own origin. WebView2 reports the full page URL as the origin, so it is reduced to scheme://host. Don't send video through `fetch` POSTs (WebView2 caps request bodies at ~4 MB/s).
- **Engine determinism** (`frontend/src/viz/`): a frame is a function of (show, analysis, size, seed, time). Layers never use `Math.random`, `Date` or `performance.now`. Use `ctx.rng(key)`, cumulative signals (`analysis.cum`) for accumulated motion, and events in a lookback ≤ 8 s for spawned things. A layer reading the previous frame sets `stateful: true`, and the engine warms it up for 1 s after a seek.
- **Mod amounts are fractions of a parameter's range** (max − min), so the same amount means the same thing on every parameter.
- **How to add a layer:** a file in `viz/layers/` that calls `registerLayer({type, label, group, icon, params, create})`, plus its type in `LAYER_TYPES` (`viz/types.ts`) and an import in `viz/layers/index.ts`. Draw premultiplied colour multiplied by `f.opacity`. Use `QuadBatch` (`viz/gl/quads.ts`) for SDF shapes and `GLSL_COMMON`/`GLSL_PALETTE` (`viz/gl/glsl.ts`) in shaders. Check it in VizLab.
- **How to add a preset:** a file in `viz/presets/` exporting a `Preset`, listed in `viz/presets/index.ts`. It must pass `validateShow` and have ≥ 3 `controls`.
- **VizLab:** `TOOLBOX_VIZLAB=1 TOOLBOX_VIEW=vizlab bin/toolbox.exe` (with the sandbox env vars) renders every preset at five moments into `<support>/tmp/vizlab/*.png`, plus `fps.json` and `hash.json`. `TOOLBOX_VIZLAB_ONLY=<preset>` limits it to one preset; `TOOLBOX_VIZLAB_LAYER=<type>` renders one layer type with its defaults; `TOOLBOX_VIZLAB_KEY=<analysis key>` uses a real analysis instead of the synthetic fixture; `TOOLBOX_VIZLAB_ARGS=<query>` passes extra lab parameters. `TOOLBOX_VIZ_FORCE_JPEG=1` adds `vizjpeg=1` to the main window URL so renders take the JPEG path; `TOOLBOX_VIZ_FIXTURE=1` adds `vizfixture=1` so the Visualizer can use the synthetic analysis (dev only).
- **Shared lyrics logic** lives in `core/lyrics` (Lyric Video's `LyricLine`/`LyricWord` are aliases of it).
- **Caches:** `cache/visualizer/<file key>/` holds analyses (`s<0|1>.json` + `.bin`, `t-….json`, `instrumental.flac`), pruned at start after 30 days or above 3 GB. Previews (`cache/visualizer/preview-*.mp4`) are pruned after a day.
- **Saved designs** are a JSON file, `<support>/visualizer/designs.json` (≤ 50 designs), behind `VisualizerService.Designs/SaveDesign/RenameDesign/DeleteDesign`.
- **The mood reader** (`<models>/mood/`) is a pinned, sha-verified download (Music and Speech packs): the arm64 file on Apple Silicon, the avx2 file elsewhere.

## Pipelines (Phase 8)

- **A run isn't a job.** The `core/pipeline` Runner is one event loop that submits tagged jobs (`Jobs.SubmitFor`, `Job.PipelineRunID/PipelineStepID`) and follows them with `Jobs.Observe`. Never block in an observer. Pipelines, runs and watch-folder state live in `pipelines`, `pipeline_runs` and `pipeline_watch_seen` (migration 0005).
- **How to make a module a pipeline step:** implement `core.Chainable` in `modules/<id>/pipeline.go`:
  - `StepDefaults`;
  - `DescribeStep`: Accepts, Produces with stable roles, Vars, Summary, and `Templates` (JSON pointers of option fields that take `{vars}`);
  - `PrepareStep`: grouping into jobs; expand `{vars}` with `core.ExpandVars(tpl, item.Vars, core.FileVars(file))`; return `core.ErrWaiting(...)` to wait for a condition;
  - `StepOutputs`: files with roles, and variables;
  - then add a `StepShape()` service method if its step options are a new type, and its `StepUI` to a `frontend/src/pipelines/steps/*.tsx` group.
- **Manual steps** ("I'll do this myself") need nothing from a module: the runner adopts untagged jobs of that module whose inputs include the waiting files.
- **Built-in steps** (rename, chat, table, zip, copy) are actions of the `pipelines` job module; Check is the runner's own. Built-in files go to `<library>/Pipelines/<pipeline name>/`.
- **Secrets** (PDF passwords) are asked at run start, live only in Runner memory and the PDF module's secret store, and are never in the DB or job options (only a `passwordRef`).
- **Temporary files:** clean-up only deletes the run's own registered outputs inside the Library, never inputs, and only when a run ends `done` or the user asks.
- **Variables:** `{name}` syntax, `[a-z][a-z0-9_]{0,31}`; `core.ExpandVars` and `frontend/src/pipelines/vars.ts` share the vectors in `core/testdata/vars.json`.

## Creator tools (Phase 8 Part B)

- **Three projects tools:** Photo Composer (`photo-composer`), Video Editor (`video-editor`), Post Builder (`post-builder`). Their documents are typed Go structs (`modules/<pkg>/document.go`, in the bindings) stored as JSON in the `projects` table (migration 0006) through `core/projectdocs` (CRUD, names, duplicate, delete; per-project files in `<support>/projects/<id>/`: `thumb.jpg`, `render.*`, `preview.mp4`). They set `Descriptor.NotAStep` (never pipeline steps).
- **Compositions render in the webview** with `frontend/src/composer/render.ts` — the editor and the export draw with the same function. Every Save stores a 1× render (`ComposerService.SaveRender`), so Post Builder's export never needs the UI. Images reach the canvas through `ComposerService.LoadImage` (orientation applied, HEIC via the engine, cached in `<support>/cache/composer/`).
- **Videos render in Go with FFmpeg** (`videoeditor` jobs; `Module.RenderProject` is also called by Post Builder's export inside its own job). Titles are ASS files in the job TempDir, burned with FFmpeg run there (as Lyric Video).
- **Photos are oriented by EXIF** (`imaging.Orientation` / `imaging.Orient`) everywhere these tools read them; Go has no HEIC decoder, so HEIC goes through the engine's `image.convert`.
- **Instagram limits** live only in `modules/posts/limits.go`. Exports strip location and metadata unless the post keeps them. Never modify source files.
- **Handoffs:** `Handoff.postSlide` opens Composer or Video Editor for a post's slide; the first save links the project to the slide.

## Edit Studio (Phase 9)

- **The engine never reads camera files.** Video reaches it only as **edit streams**: Annex-B H.264 + `.idx.json` (`modules/editstudio` makes them with FFmpeg: CFR at the project fps, GOP 10, no B-frames, an AUD per frame, SPS/PPS on every keyframe), in `cache/editstudio/src/<fileKey>/` (two tiers: preview ≤ 540 short side, export). Frames are decoded with WebCodecs `VideoDecoder` in `viz/frames/`. **Never use `<video>` seeking for rendered frames.**
- **Close every `VideoFrame` exactly once**, as soon as it is converted or dropped (decoders stall otherwise).
- A frame is a function of (project, analysis, markers, size, seed, time). `viz/edit/` and `viz/frames/` follow the engine's determinism rules; the preview (`EditCanvas`) and the export (`viz/edit/worker.ts`, plan kind `"edit"` through the same `RenderBroker`) run the same `EditEngine`. Only the stream tier differs.
- **Time units:** song ms (analysis, derived marker ids `"<lane>:<songMs>"`, custom markers, caption lines), timeline ms (clips, playhead, `Marker.ms`), source ms (`InMs`, matte ranges). `songMs = song.startMs + timelineMs`.
- The Go document (`modules/editstudio/document.go`) holds the frontend's shapes as JSON strings (`speed`, `transform`, `masks`, `effects`, `in`, `look`, `captions.style/lines`); parse them only with `viz/edit/schema.ts`. Edit the document only through `useEditStudio().edit(next, key)`; any edit to an `auto` clip clears `auto`.
- Effects use `EditParam`/`EditMod` (keyframes + marker signals `marker.<lane>` with `every`/`sections`). Visualizer types stay unchanged; a new post pass goes in `POST_TYPES` + `post/index.ts`. Output effects (bloom/vignette/grain) are project-wide (the Look) only; stateful posts (`feedback`) aren't offered.
- **Mattes** are per clip, in `<support>/projects/<id>/mattes/`, made by `matte.*` engine handlers that never download (models pinned in `modules/editstudio/models.go`, `<models>/matte/`). One matte job at a time. SAM 2 comes from the official repo at a pinned commit (`[tool.uv.sources]`), never the PyPI `sam2` package (not Meta's).
- Caches: `cache/editstudio/` (30 days, 10 GB) pruned at start.
- **How to add an auto-fill recipe:** a `Recipe` in `tools/edit-studio/autofill/recipes.ts` with golden tests on `viz/edit/fixture.ts`.
- **Part B FX** (SPEC §23):
  - **How to add an effect:**
    - a file in `viz/post/` that calls `registerPost` (kind `"pass"`, deterministic, an exact identity at defaults, `simplePass` for one-pass shaders);
    - its id in `POST_TYPES`;
    - an import in `post/fx1.ts` or `fx2.ts`;
    - a catalog entry in `inspector/effectCatalog.ts` (typecheck fails without it).
  - **One-click stacks** go in `inspector/FxStacks.ts`.
  - **Generated clips** (kinds `text`, `visual`) register with `viz/edit/generated.ts` and draw a full-frame premultiplied picture; the engine treats it like a photo.
  - **Track mattes:** `Track.Matte` makes the track above the matte. That track isn't drawn by itself, so titles go on their own track.
  - **Blend modes** beyond normal/add/screen/multiply use `BLEND_FS`.

## Composable tools and pop-outs (Phase 10)

- **Baselines and variants.** `Descriptor.Base` names the tool a variant is built on (Edit Studio → `video-studio`, Subtitles → `transcribe`); `Descriptor.Parts` lists the tools it's made of. The sidebar nests variants under their base; the top bar's `CompositionBar` shows "Built on" / "Variants" / "Uses" chips.
- **The editor** lives in `frontend/src/editor/` and is the **Video Editor** (`video-studio`, works without a song). **Edit Studio** is `editor/` + the music layer in `tools/edit-studio/`, plugged in through `EditorProfile` (`editor/profile.ts`). **Nothing in `src/editor/` imports `src/tools/`** (a test enforces it); add music features as profile slots. Both tools share one `useEditStudio` store and one document kind (`edit`). The old sequence editor is `video-editor` ("Sequence Editor", hidden; Post Builder's video slides).
- **Pop-outs:** any tool (`popOutTool`) or part (`popOutPart`, `<PartFrame>`) can open in its own window (`lib/windows.ts`, `DesktopService.PopOut`). Windows talk only through `DesktopService.Relay` → `windows:relay` (no sockets). Only the main window mounts `RenderHost`, shows job toasts, handles `app:navigate` and persists `useUI`. Drops carry `window` (the pop-out key, `""` = main) and only that window routes them.
- **Store bridge** (`state/bridge.ts`): a host window mirrors picked store values to replica windows and runs the actions they forward. Bridged values must be JSON-serialisable; load heavy data (analyses) locally in the replica.
- Tools register `useBeforePopOut(moduleId, flush)` (`lib/popout.ts`) so a pop-out never loses unsaved work. Tools of one family (base + variants) are popped out together because they share a store.
- **Minimal surfaces (SPEC §7b, §13):** a tool's top level is its input, one or two primary settings, the preview/result and the primary action. Everything else is a `ClickIn` (`components/ClickIn.tsx`; the tool root is a `ClickInHost`) with a one-line summary of its state. Bars never wrap (measure with `useElementSize`, overflow to "More…"), rails never scroll, show file names not paths, never repeat the shell's title. File tools put secondary options in the kit's `advanced` slot.
- **Editor layout:** `editor/EditorShell.tsx` (header, `Rail`, preview in a `WorkspacePreviewFrame`, one-line `selection/` bar, tracks). The editor is a workspace: `defineEditorWorkspace(profile)` (`editor/workspace.tsx`, called from `tools/video-studio/workspace.ts` and `tools/edit-studio/workspace.ts`) gives each module its `<moduleId>.panel`/`<moduleId>.preview` parts over the family bridge channels (`editor`, `editor-focus`). Panels are `ToolPanel`s that take no props: `EDITOR_PANELS` (`editor/panelDefs.tsx`) plus the profile's `panels` (Edit Studio's `MUSIC_PANELS` in `tools/edit-studio/panels.tsx`).
- **Opening another tool with inputs:** `openTool(moduleId, inputs, extra, { window })` / `openToolItems(...)` in `lib/openTool.ts` — never call `handOff` directly for a new hand-off.
- **Icons:** add any new lucide icon to `components/Icon.tsx`; `components/iconNames.test.ts` fails on unregistered names.
- **Dev handles for QA:** `window.__ui` and `window.__edit` (dev builds only).

## Composable everything (Phase 11)

- **Tools never import each other.** Shared pieces live in `blocks/` (never import a tool); a variant may import its base; composition roots (`tools/index.ts`, `parts/index.ts`, `shell/`, `views/`, `pipelines/`) may import tools. `src/architecture.test.ts` enforces it. Cross-tool actions go through `lib/toolActions.ts` (register in `tools/index.ts`); tool views are looked up with `getToolView(id)`.
- **Constituents open inside their host**: `<ToolClickIn host module inputs onUse useLabel />` (components) renders the constituent's own view in a drawer and pops it out with the same handoff; results return through `onUse` (also from the popped-out window, over the `embed` relay channel). Tool views take hand-offs only through `useToolHandoff(moduleId, cb)` (`lib/embed.ts`), never `useUI().takeHandoff` directly, and check `useEmbed()` to render compactly. Hosts report what each part would get with `useCompositionInputs(host, {...})` so the CompositionBar's "Uses" chips open the part inside the host.
- **Workspaces** (`src/workspace/`): a workspace tool keeps its document in a zustand store and calls `defineWorkspace({moduleId, store, bridge, isOpen, panels, preview, useReplica})` in `tools/<id>/workspace.ts(x)` (auto-discovered by `parts/index.ts`); its view calls `ws.useHost()` and lays out with `StudioLayout`, `WorkspaceRail`, `WorkspacePanel`, `OneLineBar`, `WorkspacePreviewFrame`. Panels take no props; replicas (`ws.isReplica()`) never save or submit jobs; bitmaps/analyses load locally in `useReplica`.
- **Every result row can be sent on**: the kit's `FileActions` offers Send to (tools that accept the file, also in a new window) and Use when embedded.
- **Click-ins inside a drawer stack over it** (their own width); `useClickIn()` inside a drawer addresses the drawer's own host. Panels that pick files or submit jobs are `poppable: false`.
- **Big local images in an `<img>`**: use `wholeImageUrl(path)` (`lib/wholeImage.ts`), never a bare media URL (media responses stop at 4 MiB and `<img>` never asks for the rest); `FilesService.ImageThumb` for previews.
- **One-time window state** (a tool window's start-up handoff, a parked session) must survive React StrictMode's double effects in dev: take it once per page, not once per effect run.

## Documents (Phase 12)

- **Document Converter** (`modules/documents`, `tools/documents/`) runs **Pandoc** with **Typst** as the PDF engine (`--pdf-engine=<managed typst>`); **Web Archiver** (`modules/archiver`, `tools/archiver/`) runs **monolith**. All three are pinned managed archives in `core/deps` (`pandoc.go`, `typst.go`, `monolith.go`; monolith is a `Raw` single-file part) in the **Documents** pack (`docs`; the OCR pack is "Text recognition").
- **Pandoc always runs with cwd = the job's TempDir** (it writes Typst's temp `.typ` and media into the cwd), with an empty `--data-dir`, `--resource-path=<input dir>` and `+RTS -M1024M -RTS`. Never `pandoc server`, never user Lua filters. Typst gets `TYPST_PACKAGE_CACHE_PATH` under the tools dir; never `typst watch`/`update`. A system Typst older than 0.12 doesn't count (`Spec.MinVersion`).
- **Render JavaScript / Also PDF** use the installed Edge/Chrome headless with a temporary `--user-data-dir` in the job's TempDir and **never a `--remote-debugging-*` flag** (tests assert it). Local/private addresses are refused unless `AllowLocal`.
- Outputs: `<library>/Documents/`, `<library>/Web Archive/<host>/<title> <date>.html`.

## Every tool composes (Phase 14)

- **Every tool is a pipeline step.** `TestEveryToolIsAPipelineStep` (root) and `pipelines/everyTool.test.tsx` fail if a sidebar tool has no automatic step type or no `StepUI`. **There is no exemption list**: a new tool ships with its `core.Chainable` and step editor. Job-less tools become steps through `core.StepProvider` (a hidden companion module; Clipboard's "Copy to clipboard"); Local Chat's step id is `llm-chat` (`pipelines.chat` is an alias); "Run another pipeline" is the built-in `pipelines` (cycles refused at save).
- **Steps that render in the webview** (Photo Composer "Fill a template", Video Editor "Assemble", Edit Studio "Cut to the beat") go through `core/viz.RenderBroker` → the main window's `RenderHost` (`vz1|host|up/down`); without a window they wait with `ErrWaiting("Open Toolbox to render")`. Pure auto-fill code lives in `editor/autofill/` so `viz/` may use it.
- **Clipboard trigger** (`Pipeline.Clip`): only after the recorder stored a copy (recording on, never sensitive); a text trigger needs a pattern; the pipeline's own copies never re-trigger.
- **Drag and drop:** `lib/fileDrag.ts` is the contract. Every file row is a drag source (`startPathsDrag`; `ResultRow`, Library rows, export rows); any in-app drop on a `[data-file-drop-target]` routes exactly like an OS drop (`installInAppDrops`); sidebar tools are drop targets and tool drag sources; the pipeline graph adds a step for a dropped tool. Drags don't cross windows.
- **Results:** use the kit's `ResultRow` (draggable, double-click opens, Send to incl. **Pipeline: …**, Reveal/Open on hover); exports of workspace tools end in `editor/export/LastExport`. A job module that writes files needs an `OutputSubdir` (or `job.OutputDir` is empty).
- **Shell:** sidebar grouped by category with Pinned/Recent and Mod+1…9; palette matches `shell/keywords.ts` + taglines; tools register `tool.addFiles` for Mod+O (the kit does); "?" opens the shortcuts overlay; completion toasts are batched and skipped when the tool is on screen; disabled buttons use `aria-disabled` so their tooltip explains why.

## New tools (Phase 15)

- **Text to Speech** (`modules/tts`, engine `tts.speak`, Kokoro int8 ONNX + `voices-v1.0.bin`, pinned sha in `modules/tts/models.go`, `<models>/tts/`, component `kokoro-voices` in the Speech pack). The handler never downloads; previews go to `cache/tts-preview` (1 day), pasted text to `tmp/tts-text` (7 days).
- **Scene Splitter** (`scenes`), **GIF & Contact Sheet** (`gif`), **Silence Cutter** (`silence`): FFmpeg jobs run with TempDir as the working directory (no Windows paths in filters; long graphs via `-/filter_complex <file>`). Contact-sheet timecodes and Image Batch text go through ASS/libass like subtitles.
- **Image Batch** (`imagebatch`): pure Go for resize/crop/pad/JPEG/PNG/logo; FFmpeg only for WebP and text watermarks. **Organizer** (`organize`, built in): **copies only**, never into or above an input; exact duplicates by SHA-256, look-alikes by 64-bit dHash; `report.csv`.
- **Local File Transfer** (`lan-share`) became a real tool in Phase 13 (see "Local File Transfer (Phase 13)").

## Focus Lock and pipeline timing (Phase 18)

- **`core/focus`** is the engine: a polling loop over `Platform` (Windows: one `NtQuerySystemInformation` snapshot per tick, ~4.5 ms, every 1 s plus an immediate tick on a window-shown kick; macOS: `kern.proc.all` sysctl, no cgo) and a pure `Decide` policy (other sessions ignored → Toolbox and descendants → OS folders, which don't confer → Windows extras → allow rules → nearest conferring seen ancestor → unknown path allowed → block). Each (PID, created) is decided once. Persistence goes through `focus.Store` (`core/store/focus.go`, migration 0008); settings key `focus`.
- **Sessions are snapshots** (profile + Always allowed at start); only one at a time; they resume after a restart and end on wake when their time passed. Weakening (end early, allow mid-session, quit) costs the strength's friction, and countdowns live in the engine. Quitting Toolbox during a real session goes through `desktop.Shell.ShouldQuit` (never during OS shutdown).
- **Pipelines learn time:** `core.ErrWaitingUntil` makes a cell wait with `Wait = time` and a persisted `RunCell.Until`, retried at that moment and on a 30 s wall-clock check (Go's timers don't count sleep on Windows), on `Runner.Resumed()` and on `Runner.WakeTimeWaits()` (called on every focus change). `StepRequest.Until` keeps a deadline fixed; `SkipWait` is Continue now. The Wait step (`pipelines.wait`) and Focus wait return zero jobs when done (files pass through).
- **Runs without files:** a pipeline where no step reads `From: "input"` (`PipelineCheck.TakesFiles` false) starts with one item and no inputs; merged items are `MergedAt != ""`, never `Input == ""`. **Schedules** (`Pipeline.Schedule`) fire only such pipelines, with catch-up, overlap skip and DST rules; last fires in `pipeline_schedule_state`.
- **Open in app** (`pipelines.open`) launches through `proc.Launch`, records the app in the focus session (`Engine.NoteLaunch`) and only ever closes politely (`focus.AskToClose`). `App` is never a template or a bind.

## Compress to Size (Phase 17)

- **`compress`** (`modules/compress`, `tools/compress/`): any file in, the same thing out under a byte limit. Kinds by extension (`KindOf`): video/audio (FFmpeg, two-pass H.264/H.265, MP3/Opus, optional split into parts), photos (pure Go JPEG/PNG, WebP via FFmpeg), animated GIF (FFmpeg palette), PDF (`pdf.CompressImages` ladder), Office (`.docx/.pptx/.xlsx` pictures recompressed, other zip entries byte-identical), anything else zipped.
- **Estimate = run.** Each kind has a pure planner shared by `estimate<Kind>` (probe only, `CompressService.Estimate`) and `run<Kind>`, so the preview is what the job does. Runs aim at `Budget(limit)` (97%), measure, retry ≤ `MaxAttempts`, and fail with `overLimit` rather than output a file over the limit. Files that already fit are copied unchanged.
- **Targets** (Discord, Gmail, …) are frozen data in `modules/compress/targets.go`, decimal MB, with `TargetsAsOf`; update the date when you change a limit. The frontend's step choices mirror the IDs.

## Parameters as inputs (Phase 16)

- **Every scalar option of a step is a parameter** (`pipelines/params.ts`: `deriveParams` walks the defaults; `StepUI.params` overrides in `pipelines/steps/paramDefs.ts` give labels, types, choices, primaries, hidden). A new option shows up by itself; `steps/params.test.ts` makes every visible one carry a deliberate label.
- **A wire into a parameter is a bind** (`PipelineStep.Binds`: option pointer → variable). The runner writes the variable into a copy of the options before `PrepareStep`, converting to the option's JSON type; an empty variable keeps the option's value. Step variables declare a `Type` (`pipeline_vars_test.go` lists them all). **Run parameters** (`Pipeline.Params`) are asked at start and become variables.
- **Value colours** are tokens `--type-files|file|text|number|toggle|choice|color|any` (files are orange; every file wire is orange). Use `valueTypeVar()`; never colour a value type any other way.

## Local File Transfer (Phase 13)

- **`core/lan`** is the protocol (LocalSend v2 in HTTPS mode + Toolbox pairing at `/api/toolbox/v1/pair`): identity (`<support>/lanshare/identity.pem`, fingerprint = lowercase hex SHA-256 of the cert DER), settings and known devices (`settings.json`, `devices.json`), discovery (multicast 224.0.0.167/ff12::167:53317 + an outbound subnet scan), the HTTPS server and the pinned client. It never imports Wails or modules; accepted sessions go to a `SessionSink`.
- **Listening** happens only while receiving is on: mode `always`, or `open` with a live window hold (`LanShareService.Hold`, renewed every 10 s, 30 s TTL). Sending and scanning never need a listener. Turning receiving off closes every socket.
- **Trust:** Toolbox peers present their identity cert as a TLS client cert, so a paired device is verified and may auto-accept; LocalSend senders are never verified and always ask. Never auto-accept on a claimed fingerprint.
- **Received files** go to `<library>/Received/<device>/` through `lan-receive` jobs (hidden module), names sanitised in `core/lan/names.go`, never overwriting, never opened. No download API (browser share), no plain-HTTP peers.

## Polish rules (every screen)

Full list in docs/specs/phase-12.md §13.1. In short:
- **One header row.** A tool's header (name, save state, undo/redo, More, primary action) goes through `<ToolHeader>` (`components/ToolHeader.tsx`), which portals into the shell's top bar (or a tool window's title bar) and renders inline when embedded. `StudioLayout` and `EditorShell` already do. With a tool header present the shell shows Search and the composition chips as icons. Don't give a header class its own `container: toolbar-compact` (ToolHeader sets it when the window is narrow).
- **No frames around a page, never a border inside a border**; one `--line` divider between regions. Canvases run edge to edge with floating toolbars. Bottom click-in bars are one line.
- **Never repeat a title**; taglines only in empty states; dense lists (≈ 32 px rows, secondary actions on hover/focus); form pages use their width with `--space-4` padding.
- One `DepsGate` banner names what's missing and carries the pack buttons. Check every change at 1180×720 and 960×600 (baseline shots in `.dev/polish/`).
- Source files are UTF-8 (a builder once wrote a cp1252 `§`, which broke the production build but not the tests).

## Conventions

- **Go**: idiomatic, context-aware, wrapped errors, stdlib `testing` only (no testify), table tests, `t.TempDir()` for files. No goroutine leaks: everything stops on ctx cancel.
- **TS**: strict + `noUncheckedIndexedAccess`; no `any` in `src/**` (enforced by `npm run check:any`). Import bindings only through `@/lib/api`. Zustand stores in `state/`; selectors must return stable references (use the provided hooks or `useMemo`, never build new arrays inside a selector).
- **CSS**: CSS Modules (`*.module.css`) + tokens from `styles/tokens.css`. No component libraries, no CSS frameworks. Every colour comes from a token.
- **Small windows**: every view must work at the 960 × 600 minimum. Workspace tools set `height: 100%` on their root so the shell's `<main>` never scrolls them (form tools may scroll as pages). Use `useMediaQuery(NARROW_QUERY | SHORT_QUERY)` from `lib/media.ts`, `useElementSize` for container-driven columns, and `collapsible` buttons inside a `container: toolbar-compact / inline-size` toolbar. Check with the survey scripts (`QA_W=960 QA_H=600`).
- **Commits**: small and descriptive, one concern each. Never push.
