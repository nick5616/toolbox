# Toolbox — Phase 3 Spec: always-on utilities, clipboard history, transcription, EXIF

Status: **APPROVED 2026-10-27** — binding.
Date: 2026-10-27. Author: architect session (Opus).

Phases 1–2 are shipped; their specs are archived in `docs/specs/phase-{1,2}.md`, and every contract there still holds unless changed here. "P1 §x" / "P2 §x" refer to those files.

---

## 0. Research findings this spec relies on

All verified hands-on on this Windows machine on 2026-10-27 (scratch dirs `.dev/p3-research/`), except where marked *docs only*.

| Topic | Finding | Consequence |
|---|---|---|
| Wails v3.0.0 desktop APIs | System tray (`app.SystemTray.New()`, menus, `AttachWindow`, template icons on mac), frameless popup windows (`Frameless`, `AlwaysOnTop`, `Hidden`, `HideOnFocusLost`, `HideOnEscape`, `Windows.HiddenOnTaskbar`), `app.GlobalShortcut.Register` (error if taken), `app.Autostart.Enable/Disable/IsEnabled` (start at login), `WindowClosing` hook can cancel close. Clipboard API is **text-only with no change notification**. | Everything for tray/hotkeys/popup is first-party; clipboard history needs another library. |
| `golang.design/x/clipboard` **v0.11.0** (2026-09-26) | No cgo on Windows/macOS (syscalls / purego-objc). `Watch(ctx)` yields `Data{Format, Bytes, Sensitive}` — event-driven on Windows (`AddClipboardFormatListener`), `Sensitive` set for password-manager copies (concealed/excluded formats). Reads/writes text and PNG images. v0.11 changed the API to `Read(ctx, fmt)` / `Write(ctx, fmt, bytes)` with errors. Read-only probe worked; a live copy event was **not** observed (agent avoided touching the clipboard). | Use it for watching + reading + writing. The architect verifies a real copy event during integration. |
| faster-whisper **1.2.1** + ctranslate2 4.8.4 | Co-resolves with the Phase 2 engine (torch/onnxruntime/numpy pins unchanged). **PyAV 19 breaks it** (`metadata_errors` TypeError) → pin `av>=16,<19` (→ 18.1.0). +157 MB to the engine. CPU int8, 4 threads, 19 s / 190 s clips: `base` 1.2 s / 10.1 s, `small` 3.4 s / 30.2 s (RTF 0.16), `large-v3-turbo` 11.4 s / 86.5 s. Only `small` transcribed the test clip correctly. Models from huggingface.co (`Systran/faster-whisper-{base,small}`, `mobiuslabsgmbh/faster-whisper-large-v3-turbo`; 142 MB / 464 MB / 1.6 GB). `snapshot_download(local_dir=…)` avoids a Windows symlink duplication bug. Segments are a lazy generator → progress = `seg.end / info.duration`, cancel between segments. Word timestamps, language detection (+probability), VAD all work. macOS: ctranslate2 runs **CPU-only** (no Metal) — *docs only*. | Transcription runs in the existing audio engine; default model `small`. Engine pyproject change ⇒ existing installs show **Update** (Phase 2 flow). |
| pywhispercpp 1.5.1 | Works, Metal dylib in the mac wheel (*docs only*), but slower than faster-whisper for turbo and has a fragile progress API. | Not used in Phase 3 (possible mac accelerator later). |
| ExifTool **13.59** | `https://exiftool.org/ver.txt` → version; `https://exiftool.org/checksums.txt` → SHA2-256 lines; downloads via `https://sourceforge.net/projects/exiftool/files/<asset>/download` (redirects to a mirror). Windows: `exiftool-<ver>_64.zip` (11 MB) → folder with `exiftool(-k).exe` (must be renamed `exiftool.exe`, else it waits for ENTER) + `exiftool_files/` (keep beside it). macOS/Linux: `Image-ExifTool-<ver>.tar.gz` = Perl script + `lib/`, run with `/usr/bin/perl` (*docs only*: macOS 14/15 ship perl 5.34; Homebrew `exiftool` also works). `-stay_open True -@ -` works on Windows: ~3 ms per command after a 0.2 s start. `-o <new>` writes a new file, never touches the input, fails if `<new>` exists. `-j -n` → JSON with numeric GPS. | ExifTool becomes the **third app-managed tool** (archive install, not a single binary). The EXIF module keeps one `-stay_open` process. |

---

## 1. Goals

1. **Always-on app:** system tray with menu, close-to-tray, start at login (opt-in), configurable **global hotkeys**, and a reusable **popup window**.
2. **Clipboard History:** opt-in recording of text and images, password-manager copies skipped, search/pin/delete, a hotkey popup to re-copy past items, retention limits.
3. **Transcribe** (faster-whisper in the audio engine): audio/video → TXT / SRT / VTT / JSON, language auto-detect or fixed, optional translate-to-English, three model sizes.
4. **EXIF:** inspect metadata of images (and read-only RAW), strip location or all metadata, edit common fields — always into **new** files.
5. **ExifTool as a managed dependency** (install/update from Settings).

## 2. Non-goals (Phase 3)

- Auto-pasting into the previously focused app (needs macOS Accessibility permission / input injection) — Phase 4 candidate. Selecting an item **copies** it and closes the popup.
- Rich text / HTML / file-list clipboard formats; clipboard sync; OCR; per-app exclusion lists.
- Diarization, subtitle burn-in, live/microphone transcription, translation into languages other than English.
- Writing metadata into RAW files; EXIF batch renaming; editing arbitrary tags (only the fixed set in §6.3).
- Linux tray/hotkeys QA.

---

## 3. Core and app-shell changes (foundation)

### 3.1 Job-less modules

Clipboard History is a tool with UI but no jobs. `core.Descriptor` gains `JobLess bool` (json `jobLess`): `Jobs.Submit` rejects it (`validation` "This tool doesn't run jobs"); the module implements `core.Module` with `Validate` returning that error and `Run` never called. The sidebar/palette treat job-less modules like others.

### 3.2 Settings additions

`core.Settings` gains (persisted keys in brackets, JSON values; validated like P2 §6.1):

| Field | Key | Default | Rules |
|---|---|---|---|
| `KeepInTray bool` | `keepInTray` | `true` | closing the main window hides it; Quit only via tray/menu |
| `StartAtLogin bool` | `startAtLogin` | `false` | applied via Wails Autostart; failure → validation error with the OS message |
| `Hotkeys map[string]string` | `hotkeys` | `{"clipboard":"CmdOrCtrl+Alt+V","quickOpen":"CmdOrCtrl+Alt+Space"}` | known action IDs only; value "" = disabled; accelerator syntax per Wails; duplicates rejected |
| `Clipboard ClipboardSettings` | `clipboard` | `{Enabled:false, Images:true, RetentionDays:30, MaxItems:500}` | RetentionDays ∈ {1,7,30,90,0 (= forever)}; MaxItems 50–5000 |

`SettingsPatch` gets matching pointer fields. Validation of a hotkey's *availability* happens in the shell (§3.4), which reports status separately.

### 3.3 Storage (migration `0003_clipboard.sql`)

```sql
CREATE TABLE clip_items (
  id           TEXT PRIMARY KEY,          -- ULID
  kind         TEXT NOT NULL CHECK (kind IN ('text','image')),
  text         TEXT NOT NULL DEFAULT '',  -- full text (kind=text), ≤ 1 MiB
  preview      TEXT NOT NULL DEFAULT '',  -- first 300 chars, whitespace-collapsed (search + list)
  image_path   TEXT NOT NULL DEFAULT '',  -- <support>/clipboard/<id>.png (kind=image)
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  hash         TEXT NOT NULL UNIQUE,      -- sha256 of kind + content
  byte_size    INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL           -- copy time; bumped on re-copy and when the same content is copied again
);
CREATE INDEX clip_items_recent_idx ON clip_items(pinned DESC, last_used_at DESC);
```

`core.ClipStore` interface (implemented by `core/store`):
`UpsertClip(ctx, ClipItem) (ClipItem, bool /*inserted*/, error)` (dedupe by hash → bump `last_used_at`), `ListClips(ctx, ClipQuery) (ClipPage, error)` (pinned first, then most recent; `Search` = case-insensitive LIKE on preview; `Kind` filter; cursor paging like outputs), `GetClip`, `SetPinned`, `DeleteClips(ids)`, `ClearClips(keepPinned bool) (deleted []ClipItem, err)`, `PruneClips(olderThanMs int64, maxItems int) ([]ClipItem, error)` (never prunes pinned; returns deleted rows so image files can be removed).

Wire types (`core/types.go`): `ClipItem{ID, Kind, Text, Preview, ImagePath, Width, Height, ByteSize, Pinned, CreatedAt, LastUsedAt}`, `ClipQuery{Search, Kind, Limit, Cursor}`, `ClipPage{Items, NextCursor}`, `ClipsRemoved{IDs}`.

New events: `clipboard:added` (ClipItem — new or bumped), `clipboard:removed` (ClipsRemoved), `clipboard:state` (`ClipboardState{Recording bool; Paused bool; Error string}`), `hotkeys:status` (`HotkeyStatus{Action, Accelerator string; Registered bool; Error string}[]` wrapped in `HotkeysChanged{Items}`), `window:show` (`ShowView{View string}` — tells a window which view to show).

### 3.4 Desktop shell (`desktop/` package — Wails-dependent; the only place besides `main.go`/`api/` allowed to import Wails)

- **Tray** (`desktop/tray.go`): icon (embedded 32 px PNG; macOS uses a template icon variant), tooltip "Toolbox", left-click shows/focuses the main window (macOS: click opens menu, per platform convention). Menu:
  - **Open Toolbox**
  - **Clipboard history** (shows popup; label includes the hotkey)
  - **Pause clipboard history** / **Resume** (checkbox; only when recording is enabled)
  - separator · **Running: N jobs** (disabled label, updated on `jobs:changed`; hidden when 0)
  - **Recent outputs ▸** last 5 (click = reveal)
  - separator · **Settings…** · **Quit Toolbox**
- **Close-to-tray:** main window `WindowClosing` hook → if `KeepInTray`, hide + cancel; first time, toast "Toolbox is still running in the tray" (frontend, via `window:show`-style event `app:hidden-to-tray`). macOS: `ApplicationShouldTerminateAfterLastWindowClosed: false`; Cmd+Q still quits. Quit path: cancel/stop jobs (P1 §4.6 shutdown) and the engine, then `app.Quit()`.
- **Start at login:** `SettingsService.Update` hook → `app.Autostart.Enable/Disable`; at startup reconcile setting vs `IsEnabled()` (setting wins; log mismatch).
- **Hotkeys** (`desktop/hotkeys.go`): `Manager.Apply(map[action]accelerator) []HotkeyStatus` unregisters all then registers each non-empty; registration errors are reported, not fatal; emits `hotkeys:status`. Actions:
  - `clipboard` → toggle the clipboard popup;
  - `quickOpen` → show + focus the main window and open the command palette (emit `app:navigate {target:"palette"}`; the frontend treats target `palette` as "open palette").
  Applied at startup and on settings change.
- **Popup window** (`desktop/popup.go`): one hidden window created at startup, `Frameless`, `AlwaysOnTop`, `Hidden`, `HideOnFocusLost`, `HideOnEscape`, `DisableResize`, `Windows.HiddenOnTaskbar`, 440×560, `URL "/?window=popup&view=clipboard"`, `BackgroundColour` = theme bg. `Toggle()` centres it on the primary screen's work area (upper third), shows, focuses, and emits `window:show {view:"clipboard"}` so the frontend resets search + selection. Hidden after an item is copied.
- **Frontend window routing:** `App.tsx` reads `?window=popup` → renders `<PopupShell/>` (no sidebar/tray; just the requested view) instead of `<Shell/>`. Stores bootstrap the same way (each window has its own JS context and subscribes to events independently — P1 §4.9).

### 3.5 Managed archive tools

`deps` gains an **archive installer** alongside `InstallManagedBinary`:

```go
type ArchiveSpec struct {
    DepID        string
    VersionURL   string                                     // returns the latest version as plain text
    ChecksumsURL string                                     // lines "SHA2-256(<asset>)= <hex>"
    Asset        func(goos, goarch, version string) (string, error)
    DownloadURL  func(asset string) string                  // e.g. SourceForge /download (follows redirects)
    InstallDir   string                                     // relative to BinDir, e.g. "exiftool"
    Layout       func(extractedRoot, installDir string) error // move/rename into place
    MaxBytes     int64
}
func (s *Service) InstallManagedArchive(ctx context.Context, job *core.JobContext, a ArchiveSpec) error
```

Flow: version → (skip if installed version equal) → checksum line for the asset → download to TempDir with progress → verify → extract (zip / tar.gz) → `Layout` into `<bin>/<InstallDir>.new` → swap atomically (rename old → `.old`, new → final, remove `.old`) → verify `--version`-equivalent → re-detect.

**ExifTool spec:** dep `exiftool` (already in the catalog) becomes `Managed`. Assets: windows → `exiftool-<ver>_64.zip`; darwin/linux → `Image-ExifTool-<ver>.tar.gz`. Download `https://sourceforge.net/projects/exiftool/files/<asset>/download`. Layout:
- Windows: `<bin>/exiftool/exiftool.exe` (renamed from `exiftool(-k).exe`) + `<bin>/exiftool/exiftool_files/`.
- macOS/Linux: `<bin>/exiftool/exiftool` (the Perl script, chmod 0755) + `<bin>/exiftool/lib/`; runs via its `#!/usr/bin/perl` shebang. If `/usr/bin/perl` is missing → install fails with hint "Install ExifTool with Homebrew: brew install exiftool".
Resolution order for `exiftool` becomes: `<bin>/exiftool/exiftool[.exe]` (managed) → `<bin>/exiftool[.exe]` → PATH → known dirs. Version check `-ver`. Hidden updater module `system-exiftool-update`; `DepsService.UpdateExiftool()`.

### 3.6 Audio engine update

`sidecar/pyproject.toml` adds `"faster-whisper>=1.2.1"`, `"av>=16,<19"` (comment: PyAV 19 breaks faster-whisper 1.2.1); version → `0.3.0`; regenerate `uv.lock` (check mac arm64 wheels for ctranslate2 and av). Existing installs become `outdated` → the Phase 2 Update flow upgrades them (Transcribe's DepsGate shows "Update audio engine").

---

## 4. Clipboard History (`modules/clipboard`)

Descriptor: `ID clipboard`, Name "Clipboard History", icon `clipboard`, Category utility, Order 300, `JobLess`, Accepts none, OutputSubdir "". Removed from placeholders.

### 4.1 Recorder (`modules/clipboard/recorder.go`)

- Started at app start when `Settings.Clipboard.Enabled`; stopped/started on settings change; `Pause()/Resume()` (in-memory; resets to recording on restart) from tray/UI.
- `clipboard.Init()` once; `Watch(ctx)` on text and (if `Images`) image formats. For each change:
  - `Sensitive` → skip (log at debug, never store).
  - Text: trim trailing whitespace; skip empty; skip > 1 MiB (store nothing, debug log); `preview` = first 300 chars whitespace-collapsed.
  - Image: decode PNG for width/height; skip > 20 MB; write `<support>/clipboard/<id>.png` (0600 perms on unix).
  - hash → `UpsertClip`; emit `clipboard:added`.
  - **Self-copy suppression:** when the app itself writes an item back (§4.2), the recorder ignores the next change whose hash matches (bumping `last_used_at` instead).
- Retention: prune on start and hourly (`RetentionDays`, `MaxItems`; pinned exempt); delete image files of pruned rows; emit `clipboard:removed`.
- Errors from the OS clipboard → `clipboard:state {Error}` and retry with backoff (1 s → 30 s); never crash.
- If `golang.design/x/clipboard` can't initialise (e.g. headless), state error "Clipboard unavailable" and stay idle.

### 4.2 Service (`modules/clipboard/service.go`, bound)

```go
List(q core.ClipQuery) (core.ClipPage, error)
Copy(id string) error            // writes text or PNG back to the system clipboard, bumps last_used_at
Pin(id string, pinned bool) (core.ClipItem, error)
Delete(ids []string) error       // removes rows + image files; emits clipboard:removed
Clear(keepPinned bool) (int, error)
State() core.ClipboardState
Pause() error; Resume() error
ImageDataURL(id string) (string, error) // "data:image/png;base64,…" (≤ 20 MB) for thumbnails/preview
OpenPopup() error                // same as the hotkey (used by the in-app "Open popup" button)
```

### 4.3 UI

- **Tool view** (`tools/clipboard/ClipboardView.tsx`):
  - When recording is disabled: an empty state explaining what's recorded, where it's stored (local SQLite + PNGs in the app folder), that password-manager copies are skipped, and a primary **Start recording clipboard history** button (sets `clipboard.enabled=true`).
  - When enabled: header with status pill (Recording / Paused / Error), Pause/Resume, hotkey hint (`Kbd`), "Open popup", "Clear…" (ConfirmDialog with "Keep pinned" checkbox).
  - Search field (`/` focuses) + kind filter (All / Text / Images); list of items (virtualised-lite: render first 200, "Load more"): text items show preview (mono, 2 lines) + relative time + char count; image items show a 64 px thumbnail (lazy `ImageDataURL`) + dimensions. Row actions: Copy (Enter), Pin/Unpin, Delete. Keyboard: ↑/↓, Enter = copy (toast "Copied"), `Mod+Backspace` = delete, `P` = pin.
  - Settings panel (collapsible): capture images switch, retention select, max items stepper.
- **Popup** (`tools/clipboard/ClipboardPopup.tsx`, rendered by `PopupShell`): search input autofocused; list of ~8 visible rows (same row component, compact); ↑/↓/Enter copies + hides window (`application` runtime `Window.Hide()` from JS, or service call); `Esc` hides (window option); pinned items first with a pin glyph; empty state "Nothing copied yet" / "Clipboard history is off — enable it in Toolbox". Number keys `1–9` copy the nth item. Re-focus on every `window:show`.

---

## 5. Transcribe (`modules/transcribe` + sidecar `handlers/transcribe.py`)

Descriptor: `ID transcribe`, icon `captions`, Category ai, Order 170, Accepts audio+video, Requires `audio-engine`, OutputSubdir `Transcripts`, SplitInputs, MaxConcurrent 1, MaxInputs 100. Removed from placeholders.

### 5.1 Options

```go
type Model string // "base" | "small" | "turbo"
type Task string  // "transcribe" | "translate"  (translate = to English)
type Options struct {
    Model    Model    `json:"model"`     // default "small"
    Language string   `json:"language"`  // "" = auto, else ISO-639-1 from a fixed list (en, es, fr, de, it, pt, nl, ja, ko, zh, ru, …)
    Task     Task     `json:"task"`      // default "transcribe"
    Formats  []string `json:"formats"`   // subset of txt|srt|vtt|json; default ["txt","srt"]; ≥1
    VAD      bool     `json:"vad"`       // default true (skip silence)
}
```

Presets (`presets.go`): base → `Systran/faster-whisper-base` (142 MB, "fast"), small → `Systran/faster-whisper-small` (464 MB, "balanced", default), turbo → `mobiuslabsgmbh/faster-whisper-large-v3-turbo` (1.6 GB, "best", slower on CPU). `Presets()` returns `PresetInfo` with `DownloadBytes`.

### 5.2 Sidecar method `transcribe.run`

Params `{input, outputDir, baseName, model (repo id), modelDir, language|null, task, formats[], vad}`. Steps: stage "Downloading model" (if `<modelDir>/<name>` missing: `huggingface_hub.snapshot_download(repo, local_dir=…)` with tqdm progress via the shim) → stage "Loading model" (`WhisperModel(local_dir, device="cpu", compute_type="int8", cpu_threads=min(8, os.cpu_count()))`, cached per model in the process) → `segments, info = model.transcribe(input, language, task, vad_filter, word_timestamps=("json" in formats))` → iterate: progress = `seg.end / info.duration`, message "Transcribing · 1:23 / 4:10", `ctx.check_cancelled()` per segment → write outputs `<baseName>.<ext>` via `UniquePath`-equivalent (Python side: append " (n)" if exists) → `ctx.output(path)` each → result `{language, languageProbability, durationSec, segments, words, outputs[]}`. SRT/VTT formatting per the research helper (`HH:MM:SS,mmm` / `.mmm`); TXT = segments joined with newlines; JSON = `{language, duration, segments:[{start,end,text,words?:[{start,end,word}]}]}`.

Model dir: `$TOOLBOX_MODELS_DIR/whisper/<preset name>` (covered by "Clear models").

### 5.3 Go module

Run: `job.Tool(sidecar.DepID)` → `Call("transcribe.run", …)` with event mapping (P2 §6 pattern) → `SetResult({language, languageProbability, durationSec, segments, outputs})` → message "English · 4:10 · 212 segments". Title = file name.

### 5.4 UI (`tools/transcribe/TranscribeView.tsx`)

FileToolLayout; options: Model as 3 radio cards (label, download size, speed hint), Language Select (Auto-detect + list), Task SegmentedControl (Transcribe / Translate to English), Formats as toggle chips (≥ 1 enforced), VAD switch ("Skip silence"). Results: recent transcripts grouped by job — language badge, duration, output files with Reveal/Open, and a **Preview** button opening a side panel with the first ~50 lines of the TXT output (read via a new `FilesService.ReadText(path, maxBytes)` restricted to library/support dirs, ≤ 256 KB).

---

## 6. EXIF (`modules/exif`)

Descriptor: `ID exif`, icon `scan-search`, Category image, Order 160, Accepts images + RAW (P1 placeholder list), Requires `exiftool`, OutputSubdir `Metadata`, SplitInputs, MaxInputs 100. Removed from placeholders.

### 6.1 ExifTool session (`modules/exif/session.go`)

One long-lived `exiftool -stay_open True -@ -` process (`proc.Start`), started lazily, serialised by a mutex, idle-closed after 5 min, restarted on failure. `Exec(ctx, args ...string) (stdout string, err)`: write args one per line + `-execute<N>`; read stdout until `{ready<N>}`; stderr captured per command. Context cancel → kill + restart. Shutdown on app quit (`-stay_open\nFalse\n`).

### 6.2 Read (direct, not a job)

`ExifService.Read(path string) (MetadataView, error)` — path must exist and have an accepted extension. Runs `-j -G1 -n -struct -charset filename=utf8 <path>` → returns:

```go
type MetadataView struct {
    Path, Name string
    Groups []MetaGroup        // ordered: File, EXIF/IFD0, ExifIFD, GPS, XMP-*, IPTC, ICC_Profile, MakerNotes (collapsed), Composite
    HasLocation bool
    Location *GeoPoint        // decimal lat/lon (+ altitude) when present
    Editable bool             // false for RAW and unsupported writers
}
type MetaGroup struct { Name string; Fields []MetaField }
type MetaField struct { Tag, Label, Value string } // Value stringified; binary blobs → "(binary, N bytes)"
```

### 6.3 Jobs: strip and edit (always new files)

```go
type Action string // "strip-location" | "strip-all" | "edit"
type Options struct {
    Action Action            `json:"action"`
    KeepOrientation bool     `json:"keepOrientation"`   // strip-all: re-add Orientation + ICC profile (default true)
    Fields map[string]string `json:"fields"`            // edit: subset of Title, Description, Artist, Copyright, Keywords, DateTimeOriginal ("YYYY:MM:DD HH:MM:SS"); "" = remove tag
}
```

- `strip-location`: `-gps:all= -xmp:geotag= -o <out> <in>`.
- `strip-all`: `-all= [-tagsFromFile @ -Orientation -ICC_Profile] -o <out> <in>`.
- `edit`: `-overwrite_original` **never**; `-<Tag>=<value> … -o <out> <in>` (Keywords → `-XMP-dc:Subject` + `-IPTC:Keywords`, multiple via comma split).
- `<out>` = `core.UniquePath(OutputDir, StemName + suffix, ext)` with suffix " (no location)", " (clean)", " (edited)". RAW inputs → validation "RAW files are read-only here".
- Validation: action enum; edit requires ≥1 field; DateTimeOriginal format; field values ≤ 2000 chars, no newlines except Description.
- Result `SetResult({action, removedTags int (from a before/after count), output})`; message e.g. "Removed 14 location tags".

### 6.4 UI (`tools/exif/ExifView.tsx`)

Two-pane: left = input file list (FileToolLayout inputs); right = **Inspector** for the selected file: header (thumbnail via `FilesService.ImageDataURL(path)` for jpg/png/webp/gif ≤ 20 MB, name, size, camera make/model, date), a prominent **location** card when GPS is present ("Contains location: 48.8584, 2.2945" + "Copy coordinates"), groups as collapsible sections (ResultTable-style rows, search filter). Actions bar applies to all inputs: **Remove location** (primary when any file has GPS), **Remove all metadata** (with "Keep orientation & colour profile" switch), **Edit…** (dialog with the six fields; applies to all selected files; shows current values when one file is selected). Results: recent EXIF outputs with Reveal/Open.

---

## 7. Settings and shell UI

- **Settings → General** (new section, top): "Keep Toolbox running in the tray when the window is closed" switch; "Start Toolbox at login" switch (error → inline); "Global shortcuts" list: action label, `HotkeyRecorder` (new component: focus → press combo → shows `Kbd`; Esc cancels; Backspace clears → disabled), status badge (Active / In use by another app / Disabled) from `hotkeys:status`; "Reset to defaults".
- **Settings → Dependencies:** ExifTool row gets Install/Update (managed) via `DepsService.UpdateExiftool()`.
- **Settings → Clipboard** section mirrors the tool's settings panel (same component).
- **Command palette:** target `palette` from `app:navigate` opens it; new commands: "Open clipboard history", "Pause/Resume clipboard history", "Clear clipboard history…".
- **Toast** on first hide-to-tray (once per install; remembered via `localStorage`).

---

## 8. Bound API changes

```go
// api/files.go — FilesService additions
ReadText(path string, maxBytes int) (string, error)     // library/support dirs only; ≤ 256 KB
ImageDataURL(path string) (string, error)               // any existing file with an image extension, ≤ 20 MB

// api/desktop.go — DesktopService (new)
HotkeyStatus() []core.HotkeyStatus
HidePopup() error
ShowMain(view string) error

// api/services.go — DepsService additions
UpdateExiftool() (core.Job, error)

// modules
clipboard.Service  (§4.2)
transcribe.Service { Defaults() Options; Presets() []core.PresetInfo; Languages() []Language; Enqueue(paths, opts) ([]core.Job, error) }
exif.Service       { Read(path string) (MetadataView, error); Enqueue(paths []string, opts Options) ([]core.Job, error) }
```

`FilesService.ImageDataURL` accepts any existing file path with an image extension (the user already chose it); it never reads non-image files.

---

## 9. Test plan

**Go**
- `core`: JobLess rejection; settings validation for new fields (hotkey duplicates/unknown actions, retention/max bounds); migration 0003 on a Phase 2 DB.
- `core/store`: clip upsert dedupe/bump, list ordering (pinned first), search, cursor paging, prune (age, count, pinned exempt, returns rows), clear keepPinned.
- `core/deps`: `InstallManagedArchive` against httptest (zip + tar.gz, checksums.txt parsing, layout callback, atomic swap keeps the old install on failure, already-up-to-date); ExifTool asset/layout functions per GOOS (Windows rename + `exiftool_files/` kept; unix chmod).
- `modules/clipboard`: recorder with a fake clipboard source (interface over `golang.design/x/clipboard`): sensitive skipped, size limits, image write + dimensions, self-copy suppression, pause/resume, prune timer (injectable clock), error backoff.
- `modules/transcribe`: Validate (formats ≥1, language list, model enum), Run against a fake Caller (params, events, result, outputs).
- `modules/exif`: session against a **fake exiftool** (re-exec helper implementing `-stay_open` framing: `-execute<N>` → `{ready<N>}`), Read JSON → MetadataView (groups, GPS detection, binary blobs), strip/edit arg building, UniquePath outputs, RAW rejection; `//go:build integration` against the real managed ExifTool (installs into a temp support dir, creates a test JPEG with GPS via exiftool, reads, strips, verifies).
- `desktop`: hotkey `Apply` with a fake registrar (status reporting, unregister on change, duplicates); tray menu model built from state (pure function → labels/enabled flags).
- Integration (`-tags integration`, `TOOLBOX_ENGINE_E2E=1`): extend the engine test — after install, `transcribe` `base` on the "Me at the zoo" mp3 (or generated speech-free audio → 0 segments handled) asserting outputs exist and SRT parses.

**Python** — `tests/test_transcribe.py`: SRT/VTT/TXT/JSON writers (pure, table-tested); param validation; slow test (`TOOLBOX_SLOW=1`) running `base` on the downloads mp3 (from `.dev/`, skipped if absent) asserting "elephants" in the text; cancellation between segments.

**Frontend** — PopupShell routing (`?window=popup`), ClipboardView states (off/recording/paused/error), popup keyboard (↑↓, Enter → Copy + HidePopup, 1–9), HotkeyRecorder (capture, Esc, Backspace), Transcribe options (formats ≥ 1), EXIF inspector (groups, location card, editable flag), Settings General section.

**Manual smoke (architect, Windows, sandboxed):** tray icon + menu; close-to-tray and Quit; start-at-login toggles the Windows Run entry and back; clipboard hotkey opens the popup over another app, Enter copies (verify with `Get-Clipboard` in PowerShell **only on test strings the architect put there itself**), password-manager concealment can't be simulated → covered by unit tests; transcribe the downloads mp3 (`small`); ExifTool install from Settings, inspect + strip a generated JPEG with GPS; still no listening sockets.

> Clipboard etiquette for automated checks: the architect may only write test strings it created and must restore the user's previous clipboard text afterwards (read it first with `Get-Clipboard`, write it back at the end). No keystroke injection (Phase 1 lesson).

---

## 10. Work packages

### Wave 0 — foundation (architect)
1. Go deps: `golang.design/x/clipboard@v0.11.0`. Core: `JobLess`, settings additions + validation (with tests), wire types + events, migration 0003 + `ClipStore` interface (store implementation stubbed), `FilesService` additions (ReadText/ImageDataURL implemented — small), `desktop/` package API stubs (`Tray`, `Hotkeys`, `Popup`, `Shell` wiring), `api/desktop.go`, module stubs (`clipboard`, `transcribe`, `exif`) with final options/presets/services, placeholders removed, `main.go` wiring (window close hook, popup window creation behind the desktop stubs, ApplicationShouldTerminateAfterLastWindowClosed=false on mac).
2. Sidecar: pyproject (+faster-whisper, av pin, version 0.3.0), `uv lock` (verify mac arm64 wheels for ctranslate2/av), `handlers/transcribe.py` stub registered.
3. Bindings regenerated; frontend: `lib/api.ts` re-exports, `PopupShell` + `?window=popup` routing in `App.tsx` (complete — small), tool view stubs, `HotkeyRecorder` component stub, settings section stubs.
4. Docs: CLAUDE.md (desktop package rule, clipboard privacy rules, how hotkeys are added).

### Wave 1 (parallel)

| WP | Owns | Acceptance |
|---|---|---|
| **D1 Desktop shell (Go)** | `desktop/**`, `api/desktop.go` bodies, the `main.go` desktop section (marked block) | §3.4; tests per §9 `desktop` |
| **CB1 Clipboard backend** | `modules/clipboard/**` (except frozen options/service signatures), `core/store/clipboard.go` + tests | §3.3, §4.1–4.2; tests per §9 |
| **TR1 Transcribe** | `sidecar/toolbox_sidecar/handlers/transcribe.py`, `sidecar/tests/test_transcribe.py`, `modules/transcribe/**` (except frozen files) | §5.2–5.3; pytest + Go tests |
| **EX1 EXIF + ExifTool** | `modules/exif/**` (except frozen files), `core/deps/archive.go` + exiftool catalog/layout changes in `core/deps/**` | §3.5, §6.1–6.3; Go tests + integration |
| **UI1 Clipboard UI** | `frontend/src/tools/clipboard/**` | §4.3; tests |
| **UI2 Shell/settings UI + Transcribe & EXIF views** | `frontend/src/tools/{transcribe,exif}/**`, `frontend/src/components/HotkeyRecorder.*`, `frontend/src/views/SettingsView*` (General + Clipboard + ExifTool row), palette commands in `frontend/src/shell/useBuiltinCommands.ts` | §5.4, §6.4, §7; tests |

UI1/UI2 code against the bindings and stubs committed in Wave 0; they run in parallel with the backend packages.

### Wave 3 — integration (architect)
Merge, regenerate bindings, full checks (Go, pytest, frontend, darwin cross-vet), engine e2e incl. transcription, ExifTool integration test, `wails3 build`, manual smoke per §9 (passive capture + seeded jobs; clipboard etiquette), DECISIONS.md, summary.

---

## 11. Acceptance criteria

1. The app lives in the tray: closing the window hides it (when enabled), the tray menu works, Quit cleanly stops jobs and the engine; start-at-login can be toggled.
2. Two global hotkeys work and are rebindable; conflicts are reported in Settings without crashing.
3. With clipboard history enabled, copied text and images appear in the tool and the popup within 1 s; password-manager copies are never stored; retention and pinning work; selecting an item puts it back on the system clipboard.
4. Transcribe produces correct TXT/SRT/VTT/JSON for the test clip with `small`, with live progress and cancellation; existing engine installs show **Update** and upgrade in place.
5. ExifTool installs from Settings on Windows; EXIF reads metadata (including GPS), strips location/all metadata and edits fields into **new** files; inputs are untouched (verified by checksum).
6. No listening sockets; nothing written outside the support/library dirs; all checks (`go vet`, `go test`, pytest, `npm run check`, gofmt, darwin cross-vet) clean; DECISIONS.md updated.

## 12. Risks

- **Clipboard library on macOS is unverified here** (purego/objc). If `Watch` misbehaves on mac, fall back to polling `changeCount` every 500 ms (decision logged).
- **Global hotkey collisions** vary per machine/app; defaults chosen to avoid common app shortcuts (Ctrl/Cmd+Alt+V, Ctrl/Cmd+Alt+Space) but users may still need to rebind.
- **Whisper on macOS is CPU-only** (ctranslate2); `small` will be slower than on GPU. A Metal path (pywhispercpp) is a candidate for later.
- **ExifTool on macOS depends on system perl**; if Apple removes it, the managed install fails with a Homebrew hint.
- **Privacy:** clipboard history is opt-in, local only, sensitive copies skipped, and fully clearable; still, recording is visible in the tray and the tool header at all times.
