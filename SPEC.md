# Toolbox — Phase 2 Spec: audio engine and audio tools

Status: **DRAFT, awaiting review.** Once the owner says "approved", this file is binding.
Date: 2026-10-27. Author: architect session (Opus).

Phase 1 (core, downloader, shell) is shipped. Its spec is archived at `docs/specs/phase-1.md`, and every contract defined there still holds unless this document changes it. Section numbers below such as "P1 §4.6" refer to that file.

---

## 0. Research findings this spec relies on

Everything below was verified hands-on on this Windows machine on 2026-10-27 in a scratch environment (`.dev/py-research/`, gitignored). Apple Silicon facts come from docs and PyPI only.

| Topic | Finding | Consequence |
|---|---|---|
| uv | Latest is **0.13.6**, with GitHub release assets `uv-<target>.{zip,tar.gz}` plus a `.sha256` per asset. `uv python install 3.12` takes ~7 s and ~68 MB. | uv becomes the **second app-managed binary** after yt-dlp, using the same verified-download flow. uv installs the Python itself, so no system Python is needed. |
| Python version | Both 3.12 and 3.13 resolve the stack. On 3.13 the first import took 18 s against 1.6 s on 3.12, and it needs an extra `audioop-lts` shim. | Pin **CPython 3.12** (`requires-python = ">=3.12,<3.13"`). |
| Environment size | `uv sync` takes 31–49 s. The venv is **~1.0 GB** (68 packages; torch CPU wheel 481 MB). The uv cache reaches 1.9 GB. | Installation is an explicit, user-triggered **"Install audio engine"** action that shows the size. Use `UV_LINK_MODE=copy` and clean the uv cache after a successful setup. |
| audio-separator **0.47.1** (2026-10-19) | Works through the Python API: `Separator(model_file_dir, output_dir, output_format, log_level)`, then `load_model()`, then `separate(path, custom_output_names)`. Extras are `cpu`, `gpu` (CUDA only) and `dml`. Gotchas: (1) it imports `audioread` without declaring it, so we declare it; (2) it depends on a nightly `onnx-weekly`, so we pin through `uv.lock`; (3) the default model dir is `/tmp/…`, so we always pass `model_file_dir`; (4) progress is reported only through tqdm on stderr; (5) it logs to its own stderr handler and writes nothing to stdout. | Use the `[cpu]` extra on every platform. On Apple Silicon the same install uses **MPS** for PyTorch models (Demucs, Roformer) and the **CoreML** execution provider for ONNX/MDX models (per the audio-separator README). macOS 14+ is required. |
| Stem models (CPU, 19 s clip) | `htdemucs.yaml`: 4 stems, 84 MB, 19.5 s. `htdemucs_ft.yaml`: 4 stems, 337 MB, 69 s. `UVR-MDX-NET-Inst_HQ_3.onnx`: 2 stems, 67 MB, 9–13 s, but RSS grew **2.9 → 3.9 GB and did not shrink**. `vocals_mel_band_roformer.ckpt`: 2 stems, 913 MB, 32 s. Models download from `github.com` / `githubusercontent.com` release assets and from `dl.fbaipublicfiles.com` (Demucs). Output names look like `<in>_(<Stem>)_<model>.<ext>`, and stem-name casing varies by model. | Offer four presets (§6.1). **Recycle the sidecar** after any job whose RSS exceeds 3 GB. Rename outputs through `custom_output_names`, matching stem names case-insensitively. |
| basic-pitch **0.4.0** (Aug 2024) | It hard-pins TensorFlow below 2.15.1, which has no wheel for py3.12. It nevertheless **works unpatched on 3.12** using the bundled ONNX model (`basic_pitch/saved_models/icassp_2022/nmp.onnx`, 230 KB) with onnxruntime, once uv excludes the TF and coremltools deps and overrides `resampy>=0.4.3` (0.4.2 imports `pkg_resources`, which is gone). Inference takes 0.4–0.8 s. On import it prints 3 harmless warnings about missing TF, tflite and coremltools. | Use it in that configuration (exact pyproject in §4.2). If it ever breaks, porting its Apache-2.0 inference and note-creation code is a fallback of about a day. That fallback is not in scope. |
| BPM / key | librosa **1.0.0**: `beat_track` returns tempo as a 1-element array. On generated test audio, a 120 BPM C-major track gave 117.45 BPM / C major (r = 0.96), and a 100 BPM A-minor track gave 99.38 / A minor (r = 0.93). Speech gave r = 0.39, so r is a useful confidence. numba's first JIT run takes 8.8 s; with a persisted `NUMBA_CACHE_DIR` it drops to 2.3 s. essentia has no Windows wheels. | librosa with Krumhansl–Schmuckler key profiles, our own ~30 lines. Persist the numba cache in the support dir and warm it up at sidecar start. |
| Sidecar process | One process ran several separations in a row, mixing models. Cold import: torch ~2 s, audio-separator +1.2 s. | One long-lived process, started lazily and stopped when idle (§4.4). |
| ffmpeg progress | `-progress pipe:1 -nostats` prints `out_time_us=…` lines and ends with `progress=end`. | The converter gets real progress from that output plus the duration from ffprobe. |
| Wails v3.0.0 | The window theme is fixed at creation; there is no public runtime setter. Dropping files reports `DropTargetDetails{ElementID, ClassList, …}`. File dialogs take `Filters []FileFilter{DisplayName, Pattern "*.mp3;*.wav"}`. | On Windows the title bar is switched with `DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE)` on the native handle (§3.6). The element ID of a drop target is used to route drops straight to a tool (§3.5). |

---

## 1. Goals

1. **Audio engine:** a uv-managed Python 3.12 sidecar that the app installs, updates, repairs and removes itself. It talks JSON Lines over stdio, with progress, logs, outputs, cancellation, crash recovery, idle shutdown and memory recycling.
2. **Stem Splitter** (audio-separator): 2-stem or 4-stem separation with fast and best presets, writing WAV, FLAC or MP3.
3. **BPM & Key**: tempo plus key with Camelot notation and confidence, shown as a results table that can be copied as CSV.
4. **Audio → MIDI** (Basic Pitch, ONNX): polyphonic transcription to a `.mid` file, with sensitivity controls.
5. **Converter** (ffmpeg, pure Go): audio, video and image presets with real progress.
6. **Shared file-tool UI kit**, so every file-based tool has the same input, options, run and results structure.
7. **Phase 1 polish:**
   - a "Send to…" action on library rows
   - drops onto a tool's own drop zone skip the chooser
   - the Windows title bar follows the app theme
   - native file pickers.

## 2. Non-goals (Phase 2)

- GPU acceleration on Windows (CUDA or DirectML). macOS gets MPS and CoreML for free; Windows stays on CPU.
- 6-stem models, custom model lists, stem-quality ensembles, and model fine-tuning.
- Writing BPM or key into the input files' tags (we never modify inputs), and a MIDI editor or preview.
- Recursing into dropped folders. Batches beyond the per-submit limit (§3.2).
- Hardware video encoders, GIF output, and per-option ffmpeg editing.
- System tray, global hotkeys, clipboard history and transcription. Those are Phase 3.
- Running the sidecar over anything but stdio. There is no HTTP, ever.

---

## 3. Core changes (foundation, done by the architect before Wave 1)

### 3.1 Job results

Some modules return data rather than files; BPM & Key is the first.

- `core.Job` gains `ResultJSON string` (json `resultJson`). An empty string means no result.
- Migration `core/store/migrations/0002_job_result.sql`: `ALTER TABLE jobs ADD COLUMN result TEXT NOT NULL DEFAULT '';`
- `JobHooks` gains `Result func(json.RawMessage)`, and `JobContext` gains `func (j *JobContext) SetResult(v any) error`. SetResult marshals v to JSON, rejects anything over 64 KB with a validation error, and hands it to the hook.
- `core.Jobs`: the Result hook stores the value on the live job and it is persisted with the final status. Retry clears it. `jobs:changed` carries it.
- The store reads and writes the `result` column.

### 3.2 Inputs that are files

- `Descriptor.MaxInputs int` (json `maxInputs`, 0 = no limit) is checked by `Jobs.Submit` with a validation error `inputs: "At most N files at a time"`. File tools use 100.
- New helper `core.ValidateFileInputs(inputs []string, exts []string) error`. Every input must be an absolute path to an existing regular file with an accepted extension (case-insensitive). Per-input errors go in `Fields["inputs.<i>"]`, with messages "File not found", "Not a file" and "Unsupported file type (.xyz)". Every file module calls it from `Validate`.
- New bound `FilesService` (`api/files.go`):
  - `Pick(ctx, moduleID string) ([]string, error)` opens a native multi-select dialog. Its filter comes from the module's `Accepts.Extensions` (`DisplayName` "<Module> files", `Pattern` "*.mp3;*.wav;…"). A cancelled dialog returns an empty slice.
  - `Stat(paths []string) []FileInfo`, with `FileInfo{Path, Name, SizeBytes int64, Exists bool, IsDir bool, Kind OutputKind}`. Kind is computed by `core.KindForPath`. The UI uses it to render input lists.

### 3.3 Dependency model

- New `core.DepState` value `DepOutdated` ("outdated"): installed, but older than the version this build expects.
- The catalog gains:
  - **`uv`**: binary `uv`, `--version` matched with `^uv (\S+)`, managed. Hint: "Installed with the audio engine". Required by nothing directly.
  - **`audio-engine`**: a *virtual* dep detected by the sidecar manager (§4.3), not by running a binary. Name "Audio engine". Purpose: "Python runtime for stems, BPM & key and MIDI (≈1 GB)". Managed. Required by `stems`, `bpm-key` and `audio-to-midi`.
- `deps.Service` gains `RegisterVirtual(id string, detect func(ctx) core.DepStatus)`. The audio engine plugs into the normal `List`, `Detect`, `Resolve` and `deps:changed` flow through it. For `audio-engine`, `Resolve` returns the venv's Python path.
- The yt-dlp updater is generalised into `deps.InstallManagedBinary(ctx, job, BinarySpec)`. It handles a release-JSON URL, an asset name per GOOS/GOARCH, a checksum source (either a sums file or a per-asset `.sha256`), archive extraction (zip / tar.gz, one named member), the size cap, the atomic rename, and a `--version` verification. yt-dlp and uv both use it. uv assets:
  - darwin/arm64 → `uv-aarch64-apple-darwin.tar.gz`
  - darwin/amd64 → `uv-x86_64-apple-darwin.tar.gz`
  - windows/amd64 → `uv-x86_64-pc-windows-msvc.zip`
  - windows/arm64 → `uv-aarch64-pc-windows-msvc.zip`
  - linux amd64/arm64 → `uv-{x86_64,aarch64}-unknown-linux-gnu.tar.gz`

  Each asset is checked against `<asset>.sha256`. The archive member is `uv[.exe]`, possibly inside a top-level folder.

### 3.4 Interactive processes

`core/proc` gains an API for processes with stdin, keeping the same hidden-window and whole-tree-kill behaviour:

```go
type Process struct{ /* … */ }
func Start(ctx context.Context, s Spec) (*Process, error) // Spec as before; stdin is piped
func (p *Process) Stdin() io.Writer                       // write-serialised by caller
func (p *Process) Wait() (Result, error)
func (p *Process) Kill() error                            // tree kill
func (p *Process) Pid() int
```

### 3.5 Drop targets route to tools

- `core.FilesDropped` gains `TargetID string` (json `targetId`), taken from `DropTargetDetails.ElementID`.
- The shell's drop handler: if `targetId` has the form `tool-drop:<moduleId>` and that module is ready and accepts at least one of the paths, it hands the accepted paths straight to that module (`useUI.handOff`) without opening the chooser, and toasts "Skipped N unsupported files" if any were left out. Otherwise it opens the chooser as in Phase 1.
- `DropZone` already sets `data-file-drop-target` and an `id`. The file-tool kit passes `id="tool-drop:<moduleId>"`.

### 3.6 Windows title bar follows the theme

- `windows_titlebar.go` (`//go:build windows`) holds `setTitleBarDark(w *application.WebviewWindow, dark bool)`, which calls `dwmapi.DwmSetWindowAttribute(hwnd, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/, &BOOL, 4)` on the native handle (`w.NativeWindow()`). A non-Windows stub does nothing.
- It is called at startup, on `settings:changed`, and on OS theme change when the theme is `system` (Wails `events.Windows.SystemThemeChanged`).
- If the native handle isn't reachable through the public API, it is logged as a decision and the title bar keeps following the OS theme (`WindowsWindow.Theme = SystemDefault`).

### 3.7 Phase 2 descriptors

The placeholder entries for `stems`, `bpm-key`, `audio-to-midi` and `converter` are removed from `modules/placeholders`. The real modules register under the same IDs, orders, names and icons. Every module gets an `OutputSubdir`:

| Module | OutputSubdir |
|---|---|
| `stems` | `Stems` |
| `audio-to-midi` | `MIDI` |
| `converter` | `Converted` |
| `bpm-key` | `""` (results only) |

---

## 4. Audio engine (sidecar)

### 4.1 Layout

```
sidecar/                         (repo; embedded into the Go binary)
  embed.go                       package sidecarfiles — //go:embed pyproject.toml uv.lock .python-version toolbox_sidecar
  pyproject.toml  uv.lock  .python-version ("3.12")
  toolbox_sidecar/
    __init__.py  __main__.py     entry: python -m toolbox_sidecar [--selftest]
    protocol.py                  message types, reader/writer (foundation)
    registry.py                  @handler decorator + Context (foundation)
    server.py                    dispatch loop, threads, cancel, shutdown
    progress.py                  tqdm shim → progress events
    handlers/system.py           system.ping / system.info / system.warmup
    handlers/stems.py            stems.separate
    handlers/analysis.py         analysis.bpm_key
    handlers/midi.py             midi.transcribe
  tests/                         pytest (dev group)
README.md                        (updated protocol doc)
```

Installed copy: `<support>/sidecar/` holds the project files, `.venv/` and `.toolbox-hash`. Other support-dir paths:
- `<support>/python/`: uv-managed CPython
- `<support>/cache/uv/`: removed after setup
- `<support>/cache/numba/`
- `<support>/models/audio-separator/`
- `<support>/models/basic-pitch/`: unused, because the model ships inside the package

### 4.2 Python project

```toml
[project]
name = "toolbox-sidecar"
version = "0.2.0"
requires-python = ">=3.12,<3.13"
dependencies = [
  "audio-separator[cpu]==0.47.1",
  "audioread>=3.0",        # imported by audio-separator but not declared
  "librosa>=1.0,<2",
  "onnxruntime>=1.31",
  "soundfile>=0.14",
  "numpy>=2.5",
  "psutil>=7",
  "pretty_midi>=0.2.11",
  "mir_eval>=0.8",
  "basic-pitch==0.4.0",
]

[dependency-groups]
dev = ["pytest>=8"]

[tool.uv]
exclude-dependencies = ["tensorflow", "tensorflow-macos", "coremltools"]
override-dependencies = ["resampy>=0.4.3"]
```

- `uv.lock` is generated with `uv lock` (universal) and committed. The architect checks that it contains `macosx_14_0_arm64` wheels for torch and onnxruntime.
- **Hash:** sha256 over the embedded files, computed in Go at build time via `sidecarfiles.Hash()` (a sorted walk of the embed FS).

### 4.3 Setup, detection and removal (`core/sidecar`, Go)

**Detection** (the virtual `audio-engine` dep):
- `<support>/sidecar/.venv/<Scripts|bin>/python[.exe]` missing → `missing`.
- Present, but `.toolbox-hash` ≠ `sidecarfiles.Hash()` → `outdated`.
- Otherwise `ok`, with `Version` = the content of `.toolbox-version` (written by setup as "toolbox-sidecar 0.2.0 · py 3.12.x · torch 2.14.1").
- Detection never starts Python.

**Setup** is a hidden system module `system-audio-engine` (MaxConcurrent 1), started by `DepsService.InstallAudioEngine()`. It refuses with a conflict error while a stems, bpm-key or audio-to-midi job is active, and stops the sidecar first. Its steps, with progress weights:

| Step | Weight | Message |
|---|---|---|
| 1. Ensure uv: resolve it, else `InstallManagedBinary(uv)` | 0–10% | "Installing uv" |
| 2. Write the project files to `<support>/sidecar/`: delete stale project files but keep `.venv` | — | — |
| 3. `uv sync --frozen --no-dev --python 3.12` with `cwd=<support>/sidecar` (env below). Progress is indeterminate, using the last meaningful uv stderr line, such as "Downloading torch (481.4MiB)", "Prepared 68 packages", "Installed 68 packages" | 10–85% | uv's line |
| 4. Run `python -m toolbox_sidecar --selftest`, which imports everything and prints one JSON line `{"python": "...", "packages": {...}}`; write `.toolbox-version` | 85–95% | "Checking the audio engine" |
| 5. `uv cache clean`, write `.toolbox-hash`, then `deps.Detect` | 95–100% | "Ready" |

Step 3 environment:

```
UV_CACHE_DIR=<support>/cache/uv
UV_PYTHON_INSTALL_DIR=<support>/python
UV_PYTHON_PREFERENCE=only-managed
UV_PROJECT_ENVIRONMENT=<support>/sidecar/.venv
UV_LINK_MODE=copy
UV_NO_PROGRESS=1
```

On failure the job fails with `tool_failed`, using the last uv `error:` line, and the hint "Check your connection and retry; see the job log for details". A partial `.venv` is left in place, and Retry or Repair re-runs `uv sync`.

**Removal:** `DepsService.RemoveAudioEngine()` stops the sidecar and deletes `<support>/sidecar` and `<support>/python`. It refuses while jobs are active.

**Models:**
- `DepsService.ModelsUsage() (int64, error)` returns the size of `<support>/models`.
- `ClearModels()` deletes its contents and refuses while stems jobs are active.

### 4.4 Runtime (`core/sidecar`)

```go
type Event struct { Kind string /*progress|log|output*/; Pct float64; Msg, Line, Level, Path string }
type Caller interface {
    // Call sends a request and blocks until its result or error. Events for the
    // request are delivered in order on the calling goroutine's behalf via onEvent.
    Call(ctx context.Context, method string, params any, onEvent func(Event)) (json.RawMessage, error)
}
type Manager struct{ … } // implements Caller
func NewManager(p core.Paths, python func() (string, error), em core.Emitter) *Manager
func (m *Manager) Stop() error                 // graceful $shutdown, then kill after 5 s
func (m *Manager) Status() Status              // {Running bool; Pid int; RSSBytes int64; StartedAt int64}
```

**Lazy start.** The first `Call` spawns `<venv python> -u -X utf8 -m toolbox_sidecar` through `proc.Start`, with `cwd=<support>/sidecar` and this environment:

```
PYTHONUNBUFFERED=1
PYTHONIOENCODING=utf-8
TQDM_DISABLE=0                    (our shim captures tqdm)
NUMBA_CACHE_DIR=<support>/cache/numba
TOOLBOX_MODELS_DIR=<support>/models
HF_HOME / TORCH_HOME / XDG_CACHE_HOME = <support>/cache/py
NO_COLOR=1
```

Calls wait for the `ready` message, with a 90 s timeout. On a timeout or an early exit the call fails with `tool_failed` "The audio engine didn't start", the hint "Repair it in Settings → Dependencies", and the last 20 stderr lines in the cause.

**Protocol** (one JSON object per line, UTF-8, lines ≤ 16 MiB):

| Direction | Message |
|---|---|
| sidecar → Go, once | `{"id":"","event":"ready","data":{"version":"0.2.0","python":"3.12.16","pid":1234}}` |
| Go → sidecar | `{"id":"<ulid>","method":"stems.separate","params":{…}}` |
| sidecar → Go | `{"id":"…","event":"progress","data":{"pct":0.42,"msg":"Separating"}}` (`pct` −1 = indeterminate) |
| sidecar → Go | `{"id":"…","event":"log","data":{"line":"…","level":"info\|warning\|error"}}` |
| sidecar → Go | `{"id":"…","event":"output","data":{"path":"/abs/file"}}` |
| sidecar → Go, exactly one per request | `{"id":"…","result":{…}}` **or** `{"id":"…","error":{"code":"tool_failed\|validation\|cancelled\|internal","message":"…","hint":"…"}}` |
| Go → sidecar | `{"id":"…","method":"$cancel"}`: set that request's cancel flag |
| Go → sidecar | `{"id":"","method":"$shutdown"}`: finish nothing new, exit 0 within 2 s |

Everything else on stdout is a protocol violation; Go logs it and ignores it. stderr is free text: Go writes it to the app log (slog, `component=sidecar`) and never parses it.

**Concurrency.** Go multiplexes many calls by `id`, and stdin writes are serialised. Python dispatches each request on a `ThreadPoolExecutor(max_workers=4)`. `stems.separate` holds a process-wide lock, so separations are serial, and the Go stems module also has `MaxConcurrent: 1`.

**Cancellation.** When ctx is done, Go sends `$cancel` and waits up to **3 s** for the request's `cancelled` error. If none arrives (a separation can't stop mid-model), Go **kills and restarts** the sidecar. All other in-flight calls then fail with `tool_failed` "The audio engine was restarted", and the call returns `ctx.Err()`.

**Crash.** On an unexpected exit, in-flight calls fail with `tool_failed` "The audio engine stopped unexpectedly" and the hint "Retry the job; details are in the app log". The next call restarts it, with backoff of 0 s, 2 s, 5 s and 15 s across crashes within 2 minutes. After that, calls fail fast for 60 s.

**Idle shutdown.** After **10 minutes** with no in-flight calls, Go sends `$shutdown`.

**Recycling.** After any call whose result has `"rssBytes" > 3 GiB` (every handler result includes `rssBytes` from psutil), Go gracefully restarts the sidecar once no other calls are in flight. This is what stops the MDX memory growth.

**Warmup.** After `ready`, Go fires `system.warmup` and ignores the result. Python then runs a 1-second synthetic librosa `beat_track` to populate the numba cache.

`api.App` shutdown calls `Manager.Stop()`.

### 4.5 Python contracts (foundation writes `protocol.py` and `registry.py` completely)

```python
# registry.py
class Context:
    id: str
    def progress(self, pct: float, msg: str = "") -> None: ...
    def log(self, line: str, level: str = "info") -> None: ...
    def output(self, path: str) -> None: ...
    @property
    def cancelled(self) -> bool: ...
    def check_cancelled(self) -> None: ...   # raises Cancelled

class HandlerError(Exception):           # → {"error": {code, message, hint}}
    def __init__(self, code: str, message: str, hint: str = ""): ...
class Cancelled(HandlerError): ...

def handler(method: str): ...            # decorator; fn(ctx, params: dict) -> dict
HANDLERS: dict[str, Callable[[Context, dict], dict]]
```

Rules:
- Handlers validate their params and raise `HandlerError("validation", …)`.
- They never write to stdout directly; Python's `print` is redirected to stderr at startup.
- They return JSON-serialisable dicts, and the server adds `rssBytes` to every result.

`progress.py` is a **tqdm shim**: a `tqdm` subclass that forwards `n / total` to the *current* request's `Context.progress` (a thread-local set by the server) with a stage message. Before `audio_separator` is imported, it is installed as `tqdm.tqdm`, `tqdm.auto.tqdm` and `tqdm.std.tqdm`. Progress messages are throttled to ≥ 100 ms apart.

### 4.6 Handlers

**`system.ping`** → `{}`.

**`system.info`** → `{python, packages: {torch, audio_separator, librosa, onnxruntime, basic_pitch}, device}`. `device` is `"mps"`/`"coreml"`/`"cpu"`, read from torch and the onnxruntime providers.

**`system.warmup`** → `{}`.

**`stems.separate`**
- Params: `{input, outputDir, model, outputFormat: "wav"|"flac"|"mp3", baseName}`.
- Creates a `Separator(model_file_dir=$TOOLBOX_MODELS_DIR/audio-separator, output_dir=outputDir, output_format=…, log_level=WARNING)`, re-creating it whenever the model changes.
- Stages:
  - model download, tqdm-driven: "Downloading model (84 MB)"
  - model load: indeterminate, "Loading model"
  - separate, tqdm-driven: "Separating"
- `custom_output_names` maps each stem to `"<baseName> - <Stem>"`, with Stem title-cased (Vocals, Instrumental, Drums, Bass, Other).
- Emits an `output` event per file and returns `{stems: [{name, path}], model, rssBytes}`.
- Checks `ctx.check_cancelled()` between stages.

**`analysis.bpm_key`**
- Params: `{input}`.
- Loads mono at 22050 Hz (librosa) and caps analysis at the first 180 s, noting `"truncated": true`.
- **Tempo:** `librosa.beat.beat_track` (unwrap the 1-element array), reported to 1 decimal place. `bpmCandidates` = [bpm/2, bpm, bpm×2] filtered to 60–200.
- **Key:** mean `chroma_cqt`, Pearson correlation against the 24 rotated Krumhansl–Schmuckler major and minor profiles. Best match → `key` ("A minor"), `camelot` ("8A"), `confidence` (r rounded to 2 decimals), and the `alternatives` top 3 as `[{key, camelot, r}]`.
- Returns `{bpm, bpmCandidates, key, camelot, confidence, alternatives, durationSec, truncated, rssBytes}`.

**`midi.transcribe`**
- Params: `{input, outputPath, onsetThreshold=0.5, frameThreshold=0.3, minNoteMs=127.7, minHz=null, maxHz=null, melodiaTrick=true}`.
- Calls `basic_pitch.inference.predict(input, model_or_model_path=<ICASSP_2022 onnx path>, onset_threshold, frame_threshold, minimum_note_length, minimum_frequency, maximum_frequency, melodia_trick)`, then `midi_data.write(outputPath)`.
- The 3 import warnings are suppressed by filtering basic_pitch's logger.
- Returns `{notes: int, pitchRange: [lo, hi], durationSec, outputPath, rssBytes}` and emits an `output` event.

---

## 5. Converter (Go, `modules/converter`)

- Descriptor: `ID converter`, icon `repeat`, Order 130, Category media, Requires `ffmpeg` and `ffprobe`, OutputSubdir `Converted`, SplitInputs true, MaxInputs 100. Accepts: audio, video and image extensions.

**Options**

```go
type Options struct {
    Preset     Preset `json:"preset"`
    MaxHeight  string `json:"maxHeight"` // "keep"|"2160"|"1440"|"1080"|"720"|"480" (video presets only)
    KeepMetadata bool `json:"keepMetadata"`
}
```

Default preset `mp3-320`, MaxHeight `keep`, KeepMetadata on.

**Presets** (`presets.go`: a pure table `Preset → {Label, Kind: audio|video|image, Ext, Args []string, AcceptsKinds}`):

| Preset | Kind | Ext | ffmpeg args (after `-i in`) | Accepts |
|---|---|---|---|---|
| `mp3-320` | audio | .mp3 | `-vn -c:a libmp3lame -b:a 320k` | audio, video |
| `mp3-v0` | audio | .mp3 | `-vn -c:a libmp3lame -q:a 0` | audio, video |
| `aac-256` | audio | .m4a | `-vn -c:a aac -b:a 256k` | audio, video |
| `flac` | audio | .flac | `-vn -c:a flac` | audio, video |
| `wav-16-44` | audio | .wav | `-vn -c:a pcm_s16le -ar 44100` | audio, video |
| `wav-24-48` | audio | .wav | `-vn -c:a pcm_s24le -ar 48000` | audio, video |
| `aiff-16` | audio | .aiff | `-vn -c:a pcm_s16be` | audio, video |
| `opus-160` | audio | .opus | `-vn -c:a libopus -b:a 160k` | audio, video |
| `mp4-h264` | video | .mp4 | `-c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart` | video |
| `mp4-h265` | video | .mp4 | `-c:v libx265 -crf 24 -preset medium -tag:v hvc1 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart` | video |
| `webm-vp9` | video | .webm | `-c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -c:a libopus -b:a 128k` | video |
| `png` | image | .png | (none) | image |
| `jpeg` | image | .jpg | `-q:v 2` | image |
| `webp` | image | .webp | `-c:v libwebp -quality 85` | image |

**Full command:**

```
ffmpeg -hide_banner -nostdin -y -i <in> [-map_metadata 0 | -map_metadata -1] <preset args> [-vf scale=-2:'min(ih,N)'] -progress pipe:1 -nostats <tmpOut>
```

- Images use `-frames:v 1`.
- The scale filter applies only to video presets when MaxHeight ≠ keep.
- `<tmpOut>` is in `job.TempDir`; on success the file is moved to `OutputDir/<stem>.<ext>`. If the name is taken, ` (1)`, ` (2)`, … is appended. The output is never the input path.

**Progress:**
- Duration comes from `ffprobe -v error -show_entries format=duration -of csv=p=0`.
- Each `out_time_us` / duration value gives pct, clamped to 0.99. `progress=end` → 1.
- Images and unknown durations are indeterminate.
- Message: "Converting · 2.4× · ETA 0:31", with speed taken from the `speed=` line.

**Validation:**
- `core.ValidateFileInputs` with all accepted extensions.
- Each input's kind must be in the preset's `AcceptsKinds`; otherwise the field error is "<Preset label> can't take a <kind> file".
- Enum checks.

**Errors:** a non-zero exit → `tool_failed` with the last ffmpeg stderr line that contains "Error", "Invalid" or "not", else the last line. Hints:

| ffmpeg error | Hint |
|---|---|
| `Unknown encoder 'libx265'` / `'libvpx-vp9'` | "Your ffmpeg build lacks this encoder; install a full build (brew install ffmpeg)" |
| `No such file` | (no hint) |

**Tests:**
- table tests for the command builder
- an ffmpeg progress parser test
- a collision-naming test
- Run against a fake ffmpeg via the re-exec helper (as in the downloader)
- an `//go:build integration` test against real ffmpeg using lavfi-generated inputs.

---

## 6. Sidecar-backed modules (Go)

All three follow the same pattern:
- `Register(reg *core.Registry, sc sidecar.Caller) error`
- `Validate` uses `core.ValidateFileInputs`
- `Run`:
  1. `job.Tool("audio-engine")`, which fails fast with the hint "Install the audio engine in Settings → Dependencies".
  2. `sc.Call(ctx, method, params, onEvent)`, where `onEvent` maps progress → `job.Progress`, log → `job.Log`, and output → `job.Output`.
  3. Decode the result.

Sidecar errors map to `AppError` with the same code, message and hint. Descriptor `SplitInputs: true`, `MaxInputs: 100`.

### 6.1 `stems` (`modules/stems`)

Accepts audio + video extensions. Order 100, MaxConcurrent 1, Recommends none.

**Options:**

```go
type Preset string // "vocals-fast"|"vocals-best"|"four-fast"|"four-best"
type Options struct { Preset Preset `json:"preset"`; Format string `json:"format"` /* wav|flac|mp3 */ }
```

The default is `four-fast` / `wav`. Preset table (`presets.go`):

| Preset | Label | Model | First-use download | Stems |
|---|---|---|---|---|
| `vocals-fast` | Vocals + instrumental · fast | `UVR-MDX-NET-Inst_HQ_3.onnx` | 67 MB | Vocals, Instrumental |
| `vocals-best` | Vocals + instrumental · best | `vocals_mel_band_roformer.ckpt` | 913 MB | Vocals, Instrumental |
| `four-fast` | 4 stems · fast | `htdemucs.yaml` | 84 MB | Vocals, Drums, Bass, Other |
| `four-best` | 4 stems · best | `htdemucs_ft.yaml` | 337 MB | Vocals, Drums, Bass, Other |

- Output folder: `OutputDir/<input stem name>/`, so each track gets its own folder. `baseName` = the input's stem name.
- Title = the input file name.
- The result is stored with `SetResult({preset, model, stems:[{name,path}]})`.

### 6.2 `bpm-key` (`modules/bpmkey`)

- Accepts audio + video. Order 110. OutputSubdir "".
- Options: `{}` (empty struct).
- Run calls `analysis.bpm_key` and stores the full result with `SetResult`.
- Message on done: "128.0 BPM · A minor (8A)".

### 6.3 `audio-to-midi` (`modules/midi`)

- Accepts audio + video. Order 120.
- **Options:**

  ```go
  type Options struct {
      Sensitivity float64 `json:"sensitivity"` // 0.1–0.9 → onsetThreshold = 1 - sensitivity (default 0.5)
      NoteFloor   float64 `json:"noteFloor"`   // frameThreshold 0.1–0.6 (default 0.3)
      MinNoteMs   float64 `json:"minNoteMs"`   // 30–500 (default 127.7)
      Range       string  `json:"range"`       // "full"|"bass"(<= 400 Hz)|"melody"(>= 200 Hz) → minHz/maxHz
      MelodiaTrick bool   `json:"melodiaTrick"` // default true
  }
  ```

- Output `OutputDir/<stem>.mid`, with the collision suffix as in the converter.
- `SetResult({notes, pitchRange, durationSec})`. Message "412 notes · C2–G5".

---

## 7. Frontend

### 7.1 File-tool kit (`frontend/src/tools/_kit/`)

- `useFileInputs(moduleId)` returns `{files: FileInfo[], add(paths), remove(path), clear(), pick()}`:
  - handles `takeHandoff(moduleId)` on mount and on handoff changes;
  - `pick()` calls `FilesService.Pick`;
  - de-duplicates, enforces `maxInputs` from the descriptor, and stats files via `FilesService.Stat`;
  - filters out unsupported extensions with a toast.
- `<FileToolLayout moduleId title tagline inputs options runLabel onRun runDisabledReason? active results?>`. It renders:
  - the header
  - the engine/deps banner slot (`<DepsGate moduleId/>`)
  - an input panel: `DropZone id="tool-drop:<id>"` when empty; a `FileList` plus "Add files…" and "Clear" when not
  - the options slot
  - the primary run button with `Mod+Enter`
  - "Active" (`JobRow compact` for this module's active jobs)
  - the results slot
- `<DepsGate moduleId/>` reads the module's `requires`:
  - **audio-engine missing:** an info Banner "The audio engine isn't installed" with "Stem splitting, BPM & key and MIDI run locally on a Python engine (about 1 GB download, 1.2 GB on disk)" and an **Install audio engine** button. While the install job runs, the button shows a spinner and the progress message.
  - **audio-engine outdated:** a warn Banner "The audio engine needs an update", with the **Update** action.
  - **ffmpeg/ffprobe missing:** as in Phase 1.
  - It returns `blocked: boolean` so the run button is disabled with a reason.
- `<ResultTable>`: a generic dense table (sticky header, mono numerics, copy-row and copy-all-as-CSV).
- `optionsState.ts`: a generic version of the Phase 1 downloader's options persistence (`useModuleOptions<T>(moduleId, defaults, sanitize)`), debounced and stored via `SettingsService.SetModuleState`. The downloader is migrated to it.

### 7.2 Tool views

- **Stems** (`tools/stems/StemsView.tsx`):
  - Options: Preset as four radio cards (label, the stems as small chips, download size and relative speed: "fast" or "best"), and Format as a segmented control wav | flac | mp3.
  - Results: the latest 10 finished stem jobs as groups. Each group shows the track name, its stems as rows (stem icon, name, size, Reveal and Open), and a "Reveal folder" button.
  - The run label is `Split N tracks`.
- **BPM & Key** (`tools/bpmkey/BpmKeyView.tsx`):
  - No options section.
  - Run label `Analyze N files`.
  - The results `ResultTable` is built from all done bpm-key jobs (newest first, max 200), with columns File · BPM (mono, with "½×/2×" candidates in a tooltip) · Key · Camelot (Badge) · Confidence (a Meter-style bar plus the number; dimmed below 0.5) · Analyzed (relative time).
  - Actions: Copy CSV (`file,bpm,key,camelot,confidence`) and Clear results (removes those finished jobs).
- **Audio → MIDI** (`tools/midi/MidiView.tsx`):
  - Options: Sensitivity slider, Note floor slider, Min note length (ms) stepper, Range segmented (Full | Bass | Melody), Melodia trick switch, and "Reset to defaults".
  - A new `Slider` component (owned by the kit WP, in `components/`): native range input styled with tokens, plus the value in mono.
  - Results: recent MIDI outputs (name, notes, pitch range, Reveal, Open).
- **Converter** (`tools/converter/ConverterView.tsx`):
  - Preset: a grouped Select (Audio / Video / Image). Its hint line shows the output extension and the input kinds it accepts.
  - MaxHeight Select (video presets only) and a Keep metadata switch.
  - Inputs that don't fit the preset are flagged inline per file, before submit.
  - Run label `Convert N files`. Results: recent converter outputs.

### 7.3 Settings and library

- **Settings → Dependencies:**
  - New rows: **uv** (action: Update, managed) and **Audio engine**.
  - Audio engine actions: Install, Update when outdated, Repair (re-runs setup), and Remove (with a confirm dialog: "Remove the audio engine? This frees about 1.2 GB. Downloaded models are kept.").
  - A new sub-row "Models: <size> · **Clear models**" (confirm dialog).
  - Add a minimal `ConfirmDialog` component (modal, focus-trapped, Esc and Enter) in `components/`.
- **Library rows:** a new "Send to…" menu (`MenuButton`, a new small component) lists the ready modules that accept the file, via `ModulesService.Match([path])`. Choosing one calls `handOff`. Missing files hide it.
- **Settings → Appearance:** no visual change. The title bar follows the theme (§3.6).

---

## 8. Bound API changes (`api/`)

```go
// api/files.go — FilesService (new)
Pick(moduleID string) ([]string, error)
Stat(paths []string) []core.FileInfo

// api/services.go — DepsService additions
InstallAudioEngine() (core.Job, error)        // also used for Update and Repair
RemoveAudioEngine() error
ModelsUsage() (int64, error)
ClearModels() error
UpdateUv() (core.Job, error)

// typed module services (bound like downloader.Service)
stems.Service      { Defaults() Options; Enqueue(paths []string, opts Options) ([]core.Job, error); Presets() []PresetInfo }
bpmkey.Service     { Enqueue(paths []string) ([]core.Job, error) }
midi.Service       { Defaults() Options; Enqueue(paths []string, opts Options) ([]core.Job, error) }
converter.Service  { Defaults() Options; Enqueue(paths []string, opts Options) ([]core.Job, error); Presets() []PresetInfo }
```

`PresetInfo{ID, Label, Kind, Ext, AcceptsKinds []OutputKind, DownloadBytes int64, Stems []string, Speed string}`. Fields that don't apply to a module are left as zero values.

`core.FileInfo` is added to `core/types.go`.

---

## 9. Repo layout additions

```
api/files.go
core/sidecar/        manager.go client.go protocol.go setup.go detect.go (+ tests)
core/proc/           process.go (Start/Process) (+ tests)
core/store/migrations/0002_job_result.sql
core/deps/           managed.go (InstallManagedBinary), uv catalog entry, virtual deps
modules/stems/  modules/bpmkey/  modules/midi/  modules/converter/
sidecar/             (Python project + embed.go, §4.1)
windows_titlebar.go  titlebar_other.go
frontend/src/tools/_kit/  tools/stems/  tools/bpmkey/  tools/midi/  tools/converter/
frontend/src/components/{Slider,ConfirmDialog,MenuButton}.tsx
```

---

## 10. Test plan

**Go** (`go test ./...`, plus `-count=20` on `core/` and `core/sidecar/`):
- `core/sidecar`, against a **fake sidecar**: the test binary re-exec'd so that it speaks the protocol from scripted behaviours. Cover:
  - ready/handshake timeout
  - concurrent calls multiplexed out of order
  - events delivered in order per call
  - error mapping
  - `$cancel` honoured, and the hard-kill path after 3 s ending in a restart
  - crash → in-flight failures, then restart with backoff
  - idle shutdown (injectable clock)
  - recycle when `rssBytes` > threshold
  - non-protocol stdout lines ignored
  - huge line (> 16 MiB) → error, not hang
- `core/sidecar` setup with a fake uv (re-exec): success, `error:` line → `tool_failed`, hash/marker written, detection states missing/outdated/ok.
- `core/deps`: `InstallManagedBinary` with zip and tar.gz members, a `.sha256` file, and a sums file (yt-dlp regression), all against httptest.
- `core/proc`: `Start`/stdin round trip; Kill kills the tree.
- `core`: SetResult (size cap, persisted, cleared on retry); MaxInputs; ValidateFileInputs; migration 0002 on an existing Phase 1 DB.
- `modules/converter`: per §5.
- `modules/{stems,bpmkey,midi}`: Run against a fake `sidecar.Caller` (event mapping, results, errors, cancel), Validate, and the preset tables.
- **Integration** (`-tags integration`, needs network and an installed engine):
  - `integration/engine_test.go` installs the engine into a temp support dir via the setup module (real uv download), then runs stems `four-fast`, bpm-key and midi on generated audio (120 BPM C-major test signal), asserting files and results. BPM within ±3, key = C major.
  - The converter's real-ffmpeg test.

**Python** (`uv run --group dev pytest` inside `sidecar/`):
- protocol encode/decode
- server dispatch, unknown method, handler exceptions → error messages
- cancel flag
- `$shutdown`
- the tqdm shim forwarding progress
- `analysis.bpm_key` on generated 120 BPM C-major and 100 BPM A-minor signals (asserting ±3 BPM and the key)
- `midi.transcribe` on a generated C-major chord (notes include C4, E4 and G4)
- `stems.separate` behind `@pytest.mark.slow`, skipped unless `TOOLBOX_SLOW=1`, using `htdemucs`.

**Frontend** (`npm run check`):
- the kit: `useFileInputs` (dedupe, maxInputs, handoff, unsupported filtering) and the DepsGate states
- `ResultTable` CSV
- Slider, ConfirmDialog, MenuButton
- each tool view's smoke test (enqueue called with paths and options)
- the converter's per-file kind mismatch
- the library "Send to…"
- the drop routing in the shell (`tool-drop:` target → handoff, no chooser).

**Manual smoke** (architect on Windows, with sandboxed support/library dirs):
1. Install the audio engine from Settings. Progress runs through to OK, and the version string is shown.
2. Split "Me at the zoo" with `four-fast`: 4 WAVs in `Stems/<name>/`.
3. BPM & Key on the generated 120 BPM file gives ~120 / C major.
4. MIDI produces a `.mid` file.
5. Convert an mp3 to flac and an mp4 to webm (360p).
6. Cancel a running separation: the engine restarts and the next job still works.
7. Idle shutdown after 10 minutes: verified through logs with a shortened timeout using the env `TOOLBOX_SIDECAR_IDLE=30s` (a dev aid).
8. Remove the engine: rows go back to Missing.
9. Still no listening sockets.

---

## 11. Work packages

### Wave 0: foundation (architect, sequential, on `main`)

1. §3.1–3.5 core changes (types, migration 0002, `SetResult`, `MaxInputs`, `ValidateFileInputs`, `FileInfo`, `DepOutdated`, `FilesDropped.TargetID`, `proc.Start`), with tests.
2. The `core/sidecar` **contract**: `Caller`, `Event`, `Status`, and the `Manager` stub with frozen signatures; the setup module's ID const `SetupModuleID = "system-audio-engine"`.
3. Python **contracts**: `sidecar/pyproject.toml`, `uv.lock` (generated, with the darwin wheels checked), `.python-version`, `embed.go` (with `Hash()`), and complete `protocol.py` and `registry.py`. `server.py`, `progress.py` and the handlers are stubs.
4. Module **stubs**: `modules/{stems,bpmkey,midi,converter}` with final `Options`, preset tables, descriptors, `Register`, the typed `Service` with `Enqueue`, and `Run`/`Validate` returning not-implemented. Remove the placeholders. Wire everything in `main.go`.
5. The `api/files.go` and DepsService additions (delegating to stubs). Regenerate and commit the bindings. Update `lib/api.ts` re-exports.
6. Frontend stubs: `tools/index.ts` entries plus stub views; `_kit/index.ts` exporting final names and props types (stub bodies); a `Slider`/`ConfirmDialog`/`MenuButton` signature stub in `components/`.
7. Docs: CLAUDE.md "Audio engine" section (paths, env vars, protocol summary, "how to add a sidecar handler"); `sidecar/README.md` updated to the final protocol.

### Wave 1 (parallel)

| WP | Owns (exclusive) | Acceptance |
|---|---|---|
| **S1 Sidecar runtime + setup (Go)** | `core/sidecar/**`, `core/deps/managed.go` and the uv and virtual-dep changes in `core/deps/**` | §4.3, §4.4 and §3.3. All §10 `core/sidecar` and deps tests pass with `-count=20`. |
| **S2 Python server** | `sidecar/toolbox_sidecar/{__main__,server,progress}.py`, `handlers/system.py`, `sidecar/tests/test_{protocol,server,progress}.py` | §4.4–4.6 (server side, system handlers, the shim, `--selftest`). pytest passes. |
| **S3 Python audio handlers** | `sidecar/toolbox_sidecar/handlers/{stems,analysis,midi}.py`, `sidecar/tests/test_{stems,analysis,midi}.py`, `sidecar/tests/conftest.py` (signal generators) | §4.6, with the analysis and midi tests passing and the slow stems test passing locally with `TOOLBOX_SLOW=1`. |
| **M1 Go audio modules** | `modules/{stems,bpmkey,midi}/**`, except the frozen `options.go` and `service.go` | §6, with tests against a fake Caller. |
| **C1 Converter** | `modules/converter/**`, except the frozen `options.go`, `presets.go` and `service.go` | §5, including the fake-ffmpeg tests and the integration test. |
| **K1 Frontend kit and app polish** | `frontend/src/tools/_kit/**`, `components/{Slider,ConfirmDialog,MenuButton}.*`, `views/SettingsView*` and `views/LibraryView*` changes, `shell/` drop routing (`DropOverlay` and the root drop handler only), `tools/downloader/options.ts` migration to the kit's `useModuleOptions` | §7.1, §7.3 and §3.5 (UI). Tests pass. |

Python builders share the uv cache at `.dev/py-research/uv-cache`, which already holds the wheels, so they don't download 1.9 GB again.

### Wave 2 (after K1 is merged)

| WP | Owns | Acceptance |
|---|---|---|
| **V1 Tool views** | `frontend/src/tools/{stems,bpmkey,midi,converter}/**` | §7.2, with smoke tests. |

### Wave 3: integration (architect)

1. Merge, regenerate bindings, and implement §3.6 (title bar).
2. Run the full checks, both integration suites (engine and converter), and `wails3 build`.
3. Run the §10 manual smoke through passive window capture and seeded jobs, as in Phase 1. No keystroke injection.
4. Update DECISIONS.md and give the summary.

---

## 12. Acceptance criteria

1. From a clean support dir, a user can install the audio engine from inside the app and then split stems, detect BPM and key, and transcribe to MIDI. All of it runs offline after the model downloads.
2. The converter handles every preset in §5 on real ffmpeg (verified by the integration test).
3. Cancelling any audio job returns the UI to idle within 5 s, with no orphaned Python or ffmpeg processes.
4. The app never opens a listening socket. The sidecar uses only stdio. Models and Python live under the support dir; nothing is written to `/tmp`, `~/.cache` or the user's home, apart from the library outputs.
5. `go vet`, `go test ./...`, `gofmt`, `npm run check` and pytest are all clean on `main`. The integration suites pass on this machine.
6. DECISIONS.md is updated, and CLAUDE.md gains the audio-engine section and "how to add a sidecar handler".

## 13. Risks

- **The ~1 GB engine download and 3–4 GB RAM during MDX separation.** Mitigated by an explicit install, a size warning and recycling. Machines with 8 GB of RAM may struggle with `vocals-best`.
- **basic-pitch is effectively unmaintained.** It is pinned and isolated behind `midi.transcribe`; the fallback is porting its ONNX inference (about a day).
- **audio-separator depends on a nightly `onnx-weekly`.** `uv.lock` pins it, and an Update re-resolves only when the architect regenerates the lock.
- **Mac acceleration (MPS/CoreML) is unverified here.** You verify it on the Mac; CPU still works there.
- **Model hosts (GitHub releases, `dl.fbaipublicfiles.com`) could move.** audio-separator owns those URLs; updating the pinned version fixes them.
