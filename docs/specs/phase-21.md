# Toolbox — Phase 21 Spec: Workspaces, a real Video Editor, a calmer Visualizer, Color Grader, and the demo

Status: **APPROVED 2026-11-19, built 2026-11-19 to 2026-11-20** (rev 2: Part E Color Grader added and `demoAssets/` mapped). See docs/DECISIONS.md for every deviation.

Phase 20 (Smart search and Caption Writer) is archived in `docs/specs/phase-20.md`. Every earlier rule still holds:
- **every tool stands on its own** (CLAUDE.md, 2026-11-06);
- every sidebar tool is a pipeline step with a `StepUI`;
- every file row is a draggable `ResultRow` with Send to, Reveal, Open and Save a copy;
- accessibility (a tooltip on every control, `aria-disabled` with a reason, keyboard reachability), 960 × 600 and light/dark always apply;
- the performance rules (2026-11-17);
- **never start a real Focus session while developing** (every capture run is a dry run).

---

## Overview

You want to show Toolbox to people who don't know you, on a fixed set of media that isn't personal, and film a demo of everything it does. That needs five things.

**Part A — Workspaces.** A workspace is a folder that holds its own library and its own app data (history, projects, settings, caches, search index). You switch between them from the sidebar or the tray.
- **Personal** is what you have today. It's left exactly where it is; nothing moves.
- **Demo** starts from a **baseline folder** (`demoAssets/`): its library begins as a copy of it, and **Restore baseline** / **Tidy up after a demo** put it back.
- **Dev** is the sandbox I already use (`.dev/`).
- All workspaces share one **tools folder** (FFmpeg, the AI engine, models), so a new workspace costs no downloads.
- A demo workspace has **Hide personal details** on: paths show as `Demo/Library/…`, never `C:\Users\<you>\…`, and the device name is "Toolbox Demo".

**Part B — The Video Editor at practical parity.** You'll edit the demo in it, so it has to feel like a modern editor. Today it can't even play without a song, and clip audio is silent in the preview. This phase adds:
- playback with no song, and real preview audio from every clip;
- **audio tracks** with waveforms, fades and volume keyframes;
- a timecode ruler, scrubbing, zoom keys and a zoom slider, and track heights;
- razor, ripple delete, close gap, roll, slip, copy/paste and overwrite/insert moves;
- linked audio;
- keyframes you can see and drag on the timeline, plus ease in/out curves;
- crop and picture-in-picture presets;
- **chroma key** (green screen) and luma key;
- faster seeking and back-stepping, a Draft/Full preview, and real export settings.

**Part C — A calmer, more human Visualizer.** Today many presets jump around. The audit found these causes:
- **A real bug.** Speed and spin parameters are multiplied by song time or the beat count, so any modulation of them teleports the picture, and it gets worse later in the song.
- **Raw signals.** Levels are almost unsmoothed.
- **Too much at once.** Camera effects stack on every beat, palettes churn on every chord, drops pile everything on, and there's no master calm control.

This phase fixes the engine, retunes every preset to a **motion grammar** (big changes on phrases, gentle movement on beats, small accents on hits, and stems with distinct roles), and adds a **motion metric** to VizLab so "calmer" is measured, not guessed.

**Part D — The demo footage.** A committed capture harness (`demo/`) drives the real app on the demo media:
- it uses a synthetic, neutral cursor and records 1920 × 1080 clips over the WebView's DevTools screencast. That records only the app, never your desktop.
- it films **one clip per tool or process**, plus **B-roll** (Visualizer renders, a Paint+ time-lapse, library scrolls and more) and stills.
- everything goes into the Demo workspace under `Library/Demo Footage/`, with a shot list and a **rough-cut Video Editor project**, ready for you to edit.

**Part E — Color Grader** (a new tool, `grade`). AI colour grading for pictures and videos, from tasteful film looks to **absolutely unhinged**:
- **Looks:** a **Wildness** dial (Tasteful → Bold → Bonkers) and a gallery of 40 looks, previewed live on your own picture.
- **Vibe:** type "haunted vaporwave mall at 3 am" and the local chat model writes a look.
- **Read the picture:** the local vision model looks at it and suggests six looks that fit.
- **Smart regions:** grade the subject, the background, people, or near and far differently (near and far use a new local depth model). That gives you a neon subject on a black-and-white city, or a rainbow by distance.
- **Steal a look** from a reference picture.
- **Chaos:** seeded random looks you can lock and reroll.
- **Video:** animated looks (hue cycles, beat pulses) that stay under the flash limit.
- **Outputs:**
  - full-resolution exports;
  - a `.cube` LUT of the colour part;
  - saved looks;
  - the same looks as Video Editor effects.

### Goals
- **Isolation you can trust.**
  - Opening Demo shows nothing from Personal: no files, history, recents, clipboard, search results, projects, devices or paths.
  - Switching back to Personal shows everything as it was.
- **Editing the demo is pleasant.**
  - The checks in §B11 pass on the real demo footage: play, scrub, cut, overlay, key a green screen, keyframe a PiP, mix music under it, and export.
  - Seeking feels immediate.
- **Visuals feel human.**
  - Every preset passes the motion targets (§C6): no more than 3 flashes per second anywhere (the WCAG limit), no teleports, and at least half the frame-to-frame churn of today.
  - You approve the before/after renders.
- **Footage you can cut.**
  - Every tool appears in a clip that shows what it does, from input to result, on the demo media.
  - Clips are 1080p30, have handles at both ends, and are listed in the shot list.
- **Grades that make people say "what".**
  - Bonkers looks are genuinely wild but still read as the picture.
  - Every look renders the same in the preview and the export.
  - Animated looks never exceed 3 flashes per second.

### Non-goals (this phase)
- Two workspaces open at the same time. Switching relaunches the app.
- Per-workspace tools folders, and sync or sharing of workspaces.
- **Video Editor:**
  - multicam, nested sequences, motion tracking, colour wheels/curves (the effects stay as they are);
  - audio effects beyond gain, fades and keyframes;
  - proxies beyond the existing two stream tiers.
- **Capture:**
  - app audio in screen recordings (the UI clips are silent; tool outputs such as Visualizer renders carry their own audio);
  - footage of pop-out windows;
  - capture on macOS (WKWebView has no DevTools screencast; Workspaces work on both OSes).
- Voice-over, music choice and the final edit. Those are yours.

---

## 0. The demo media (`demoAssets/`, 64 files, 185 MB, mapped 2026-11-19)

| Role | From `demoAssets/` | Used by |
|---|---|---|
| `song.main` | `Arctic Monkeys - Do I Wanna Know.mp3` (4:32) | Stems, Visualizer, Lyric Video, B-roll |
| `song.alt` | `yeule - dazies.mp3` (4:30) | Visualizer B-roll, the rough cut's music bed |
| `song.short` | `tickle hehe (bubbes) song 43 suite 6.mp3` (1:40), `THE MOST INTENSE MINUTE…` (1:10) | Edit Studio, Color Grader beat sync |
| `stems.*` | Paramore "Misery Business" and underscores "Lovefield", 4 stems each (FLAC) | BPM & key, Audio to MIDI (bass), Edit Studio (a mix made from the stems) |
| `audio.meme` | `Mom get the camera!!.mp3`, `(COPY RIGHTED)SIKE…mp3` | Transcribe, TTS comparison, Library variety |
| `video.green` | `Snoop Dog Dancing.mp4`, `Shitty Explosion.mp4`, `Quick Scoping.mp4`, `Round Winning Kill.wmv` (green); `Wally.mp4` (**blue** screen) | Video Editor chroma key, Converter (WMV), Color Grader video, GIF |
| `photo.*` | 13 iPhone HEIC photos (Bangkok streets, rain, skyline, ferris wheel, a T-shirt, a plover drawing, a dessert, a flower ceiling) + `IMG_5171 Copy.JPG` (a perspective sketch) | Library, Smart search, Background Remover (T-shirt), Eraser, Redact (rainy street), Image Batch, Organizer, Composer, Post Builder, Caption Writer, Color Grader |
| `image.small` | `rainbowfrog.gif` (129 × 111), `original-10073724-1.jpg` (drum chart, 248 × 350) | Upscale, OCR, GIF |
| `image.screens` | 18 screenshots (games, the code editor, Toolbox's own UI, a beat editor) + `stitch stitch fix.png` | OCR (code), Smart search, Paint+ reference |

**Missing roles, generated by `demo/make-assets.mjs`** into `.dev/demo-generated/`. Wave 3 makes them through Toolbox itself and copies them into the workspace as `Library/Extras/`, which is a `keep` folder:
- **`doc.text`:** "Ten basic drum beats, explained", a short Markdown article I write (matches the drum chart).
- **`doc.pdf`:** that article through Document Converter → a 4-page PDF.
- **`video.talk`:** a 70 s narration of the article with Text to Speech (Kokoro, voice `am_michael`), with deliberate pauses, over a slow Ken Burns slideshow of 8 of the photos. It's 1080p30, made with FFmpeg.
- **`audio.noisy`:** the narration with pink noise at −28 dB and a 60 Hz hum.
- **`video.broll`:** 6 × 12 s Ken Burns clips of the night and rain photos (1080p30).
- **`stems.mix`:** "Misery Business (from stems).flac", the 4 Paramore stems summed.

**Links (Downloader, Web Archiver):** a public-domain video file and a Wikipedia article from Wikimedia, fixed in `demo/roles.json`. These are the only scenes that use the network.

**Privacy** (see §F):
- All 14 iPhone photos carry **GPS** (Bangkok). The Demo workspace's copies have location stripped (§A4); `demoAssets/` itself is never modified.
- **Excluded from the Demo workspace by default** (`exclude` in `workspace.json`; remove the lines to bring them back):
  - `Screenshot 2026-10-09 222739.png`: a selfie;
  - `Screenshot 2026-11-10 224450.png`: a home floor plan;
  - `Screenshot 2026-10-06 095221.png`: a personal "I've sketched…" text;
  - `*.asd` (Ableton analysis files).
- Several songs are commercial recordings. They're fine on your machine, but a published demo with them may get copyright claims.

Both `demoAssets/` and `workspaces/` are git-ignored, because the media is large and licensed.

---

# Part A — Workspaces

## A1. Product

- **Workspace chip.** It sits at the top of the sidebar: an icon, the workspace name and a colour dot (Personal has no dot). Clicking it opens a menu:
  - the workspaces, with a check on the current one;
  - **New workspace…**;
  - **Manage workspaces…** (Settings → Workspaces).

  The tray menu has a **Workspace ▸** submenu, and the palette has **Switch workspace…**.
- **Switching.** Toolbox quits and reopens in the other workspace. It reuses the existing relaunch, so the Focus quit friction applies during a real session, and unsaved work is flushed through `useBeforePopOut`'s flush list before quitting. Under `wails3 dev`, switching shows "Restart the dev server with TOOLBOX_WORKSPACE=…" (as the tools-folder move does today).
- **Settings → Workspaces** (new page). It lists every workspace with its name, kind, folder (Reveal) and library size (computed lazily), and has these actions:
  - **New workspace…** opens a dialog:
    - **Name** (1–40 characters).
    - **Folder**: default `<parent>/<Name>`. The parent is remembered, and starts as `~/Toolbox Workspaces`.
    - **Kind**: Standard or Demo.
    - **Start from a folder (optional)**: the baseline.
    - **Hide personal details**: on for Demo.

    Create writes the folder and opens it.
  - **Add existing folder…** takes a folder that has `.toolbox/workspace.json` and adds it to the list.
  - **Rename**, **Reveal**.
  - **Remove from list.** It never deletes files, and says so.
  - For the current workspace only:
    - **Restore baseline**;
    - **Tidy up after a demo…** (Demo kind only);
    - the **Hide personal details** toggle.
- **Personal can't be renamed, removed or tidied.**
- **What's shared and what isn't:**

| Shared by every workspace (global) | Per workspace |
|---|---|
| Tools folder (`bin/`, `python/`, `sidecar/`, `models/`) and moving it | Library, job history, outputs, lineage, projects, pipelines and runs, watch folders, schedules |
| The workspace list and the last active workspace | Settings (theme, concurrency, hotkeys, module state, chat settings, search settings) |
| Start at login (it always opens **Personal**); the tools detection cache (`<tools>/deps-cache.json`, moved from the support dir) | Clipboard history, Vault, Smart search index, Focus profiles and history |
| | Local File Transfer identity, alias, paired devices and receive mode |
| | Caches, logs, tmp, WebView storage (UI state, recents, pins) |

## A2. On disk

```
<global support>/                    %AppData%\Toolbox  (macOS ~/Library/Application Support/Toolbox)
  workspaces.json                    the list + last active (new)
  …everything Personal has today     (unchanged: Personal's support dir IS the global support dir)

<workspace root>/                    any folder, e.g. <repo>/workspaces/demo
  Library/                           the workspace's library (fixed: Settings shows it read-only)
  .toolbox/                          the workspace's support dir
    workspace.json                   {id, name, kind, baseline, present, keep, created}
    baseline-manifest.json           {files: [{rel, size, sha256}]} after seeding
    toolbox.db, logs/, cache/, tmp/, projects/, clipboard/, lanshare/, visualizer/, webview2/, …
```

```go
// core/workspace (no Wails). Frozen in Wave 0.
type Kind string // "personal" | "standard" | "demo" | "sandbox"

type Info struct {
	ID       string `json:"id"`       // "personal" | 12 hex chars
	Name     string `json:"name"`
	Kind     Kind   `json:"kind"`
	Root     string `json:"root"`     // "" for personal
	Baseline string `json:"baseline"` // absolute; "" = none
	Present  bool   `json:"present"`  // hide personal details
	Keep     []string `json:"keep"`   // library-relative folders Tidy never touches; default ["Demo Footage", "Extras"]
	Exclude  []string `json:"exclude"` // baseline-relative globs the seed skips (path.Match, "/" separators, case-insensitive)
	StripLocation bool `json:"stripLocation"` // seed/restore strip GPS from photo/video copies
	Created  int64  `json:"created"`  // unix ms
	Current  bool   `json:"current"`
	Missing  bool   `json:"missing"`  // root not found (unplugged drive)
}

type Boot struct {
	Info       Info
	Paths      core.Paths // SupportDir = <root>/.toolbox; ToolsDir = the global tools folder
	LibraryDir string     // <root>/Library ("" for personal = settings as today)
	Sandboxed  bool       // launched by TOOLBOX_SUPPORT_DIR or TOOLBOX_WORKSPACE
	SeedPending bool      // a baseline copy must run on this boot
}

func Resolve(args []string) (Boot, error)
```

## A3. Boot (what `main.go` opens)

**Order** (the first that applies wins):
1. `TOOLBOX_SUPPORT_DIR`: today's sandbox, unchanged. Kind `sandbox`, named "Dev sandbox". `TOOLBOX_LIBRARY_DIR` and `TOOLBOX_TOOLS_DIR` work as now.
2. `TOOLBOX_WORKSPACE=<root>`: that folder, created if missing. Kind comes from `workspace.json`, else `sandbox`. The env var also sets these:
   - `TOOLBOX_WORKSPACE_BASELINE` gives a new workspace a baseline;
   - `TOOLBOX_WORKSPACE_KIND` / `TOOLBOX_WORKSPACE_NAME` apply on creation.
3. `--workspace <root|id>` on the command line. Relaunch and Start-at-login pass it. A root that isn't in the list is added.
4. `workspaces.json` `active`.
5. Personal.

**Tools folder.** `TOOLBOX_TOOLS_DIR`, else the global support dir's `tools-location` pointer, else the global support dir. Moving the tools folder from any workspace moves the global one.

**Sandboxed.** Rules 1 and 2 count as sandboxed:
- **Single instance:** sandboxed runs get their own lock (`dev.toolbox.app.<sha6(supportDir)>`), so they can run beside the real app as today.
- **The global support dir:** sandboxed runs never write it (no `workspaces.json`). They read the tools pointer only when `TOOLBOX_TOOLS_DIR` is unset.

**Not sandboxed** (rules 3–5): **one lock for all of them** (`dev.toolbox.app`), so only one real workspace runs at a time.
- A second launch hands its arguments (dropped or "Open with" files) to the running instance, whatever workspace that is.
- `--workspace X` while another workspace runs asks "Switch to X?" in the running window.

**For every workspace:**
- **WebView2 profile:** `<support>/webview2` for every non-personal workspace. This isolates localStorage.
- **DevTools:** `TOOLBOX_DEVTOOLS_PORT` works only when sandboxed (as today).
- **Focus:** a dry run unless `TOOLBOX_FOCUS_DRYRUN=0`. `core/focus/dryrun.go` reads the boot's `Sandboxed` instead of the env var.
- **Hotkeys:** `TOOLBOX_NO_HOTKEYS=1` (new, honoured in any workspace) registers no global hotkeys. Capture uses it.

**Library dir.** For non-personal workspaces it's fixed to `<root>/Library`. `SettingsService` refuses changes with "This workspace's library is part of the workspace folder".

**Window title.** "Toolbox — <Name>" for non-personal workspaces. The tray tooltip carries the same suffix.

**New workspace boot.** If `workspace.json` has a baseline and no `baseline-manifest.json`, the boot submits a `workspace-seed` job after the window shows (the deferred chores goroutine). The Library shows its progress in an empty state ("Copying the starting files… 312 of 480").

## A4. Baseline, Restore, Tidy (hidden module `workspace`, jobs; `Descriptor.Hidden`)
- **seed:**
  - Copies `<baseline>/**` into `Library/`, keeping the folder structure.
  - Skips hidden files, symlinks, junctions and anything matching `exclude` (globs relative to the baseline, `workspace.json`). Copies with `core/par` at 6 workers.
  - **Strip location** (`stripLocation`, on for Demo kind, on whenever Present is on at creation):
    - Photos and videos are copied, then GPS, location and the camera serial are removed from the copy with ExifTool (`-gps:all= -xmp:geotag= -SerialNumber=`, the same tags the Metadata tool's "Strip location" removes).
    - Without ExifTool, JPEG/PNG/WebP are stripped in pure Go (EXIF GPS IFD dropped). HEIC/MP4 copies are then flagged in the job log, and the seed job ends with a warning naming them.
  - Writes `baseline-manifest.json` with, for every file: `rel`, `srcSha256`, `size` and `sha256` of the copy. Restore compares copies against `sha256` and re-derives them from the source the same way.
  - **Never writes to the baseline.**
  - Registers the files as library files the same way as an import, with no job outputs, so they appear in the Library and get indexed by Smart search if that pack is installed.
- **restore:** re-copies baseline files that are missing or whose size or sha256 differ from the manifest. Deletes nothing. Reports "Restored 3 files".
- **tidy (Demo kind only):**
  1. A preview lists every library file that isn't in the manifest and isn't under a `keep` folder, with a count and total size.
  2. On confirm, it moves them to the OS trash (`core/trash`) and clears finished job history. Projects, pipelines and settings stay.

  Running jobs block tidy ("Wait for 2 jobs to finish").
- **Safety:** every path is checked with `core.IsWithin(<root>/Library)`. Links are never followed. Restore and tidy run only on the current workspace.

## A5. Hide personal details (`Info.Present`)
- **`lib/displayPath.ts`** `displayPath(p)`:
  - inside the workspace root → `<Name>/…` (e.g. `Demo/Library/Stems/song (vocals).flac`);
  - inside the home dir → `~/…`;
  - else unchanged.

  With Present off, it returns `p` unchanged in Personal and Standard workspaces.

  These places use it:
  - the kit's `FileActions`/`ResultRow`/`ResultTable`/`ResultCards`/`LastExport` tooltips and "saved to" lines;
  - the Library (path bar, detail panel, Other places);
  - Settings (library folder, tools folder, workspace folders);
  - `DepsGate`, the job tray and log panel headers;
  - `lib/errors.ts` (AppError messages and hints have the root and home rewritten).
- **Local File Transfer:** the default alias is "Toolbox Demo" (Demo kind) instead of the hostname, and the hostname is never shown.
- **Native dialogs (Save a copy…, Reveal):** these still show real paths, because the OS draws them. The capture never opens them (§D3).
- **A Go-side `Presenter`** (in `core/workspace`) does the same rewrite for paths in notification toasts and tray labels.

## A6. API (`api/workspaces.go`, `WorkspacesService`)
```
Current() workspace.Info
List() []workspace.Info
Create(req CreateRequest) (workspace.Info, error)   // {name, root, kind, baseline, present}; validates; writes the folder + workspace.json; does not switch
AddExisting(root string) (workspace.Info, error)
Rename(id, name string) error
Remove(id string) error                            // list only
Switch(id string) error                            // relaunch
SetPresent(on bool) error
Restore() (core.Job, error)
TidyPreview() (TidyPlan, error)                    // {files: n, bytes, sample: []string (≤ 20, display paths)}
Tidy() (core.Job, error)
```
- **Validation:**
  - Root must be absolute and must not be inside another workspace's root or the global support dir.
  - An existing non-empty folder without `.toolbox/` gets a `ValidationError` with the hint "Pick an empty folder, or use Add existing".
  - The baseline must exist and must not be inside the new root.
- **Events:** `workspace:changed` (Info).

## A6b. Where every piece of app data lives (the isolation audit, 2026-11-19)

Everything a user makes or the app remembers is in the workspace. In a non-personal workspace that means `<root>/.toolbox/` or `<root>/Library/`.

| Data | Where (per workspace unless marked) |
|---|---|
| **Local Chat conversations and messages** | DB `chat_conversations` / `chat_messages` |
| **Job history, job logs, the job tray and the log panel** (the two bottom panels) | DB `jobs`, `job_logs`; the live tray reads the same job manager |
| Outputs, lineage, tags | DB `outputs`, `output_inputs`, tags |
| Pipelines, runs, watch-folder state, schedules and their last fires | DB `pipelines`, `pipeline_runs`, `pipeline_watch_seen`, `pipeline_schedule_state` |
| Projects (Composer, Video Editor / Edit Studio, Post Builder, Paint+) | DB `projects` + `<support>/projects/<id>/` (thumbs, renders, mattes, depth, Paint tiles) |
| Settings, including module state, hotkeys, chat settings, search settings and focus settings | DB `settings` |
| Clipboard history | DB `clip_items` + `<support>/clipboard/` |
| Vault | `<library>/Vault…` (it follows the library), plus `tmp/vault-open` |
| Smart search index, labels, query vectors | DB (migration 0011) |
| Caption Writer batches | `<library>/Captions/` |
| Focus profiles, sessions and history | DB (migration 0008) + `cache/focus-icons` |
| Local File Transfer identity, settings, devices | `<support>/lanshare/` |
| Visualizer designs, analyses | `<support>/visualizer/designs.json`, `cache/visualizer/` |
| Color Grader looks, maps | `<support>/grade/looks.json`, `cache/grade/` (Part E) |
| Paint+ imported brushes | `<support>/paint/…` (from `modules/paint`'s support dir) |
| All caches (thumbs, heic, media, composer, editstudio, pdfium, yt-dlp, redact, …) | `<support>/cache/…` |
| Temp files, job TempDirs, the chat key file | `<support>/tmp/…` |
| Logs | `<support>/logs/toolbox.log` |
| UI state: recents, pins, sidebar, panel sizes, view modes, the pipeline editor's mode | WebView `localStorage`, in the workspace's own WebView2 profile (`<support>/webview2`) |
| **Shared on purpose:** tools (`bin`, `python`, `sidecar`, `models`), `deps-cache.json`, the workspace list | the global tools folder / global support dir |
| **Machine-wide, out of our hands:** the OS clipboard, OS trash, OS notifications, Ollama's own data | — |

**Edge cases, each with its answer:**
- **Hard-coded global paths.**
  - `modules/posts/sources.go` falls back to `core.DefaultLibraryDir()` (`~/Toolbox`), which would read Personal's library from Demo. Its config always gets the workspace's library, and the fallback is removed.
  - `core/jobs.go`'s `os.TempDir()` fallback becomes an error (a missing tmp dir is a wiring bug).
  - A Go test (`workspace_isolation_test.go`, at the root) fails on any non-test call to `os.UserConfigDir/UserHomeDir/UserCacheDir/TempDir`, `core.DefaultLibraryDir` or `Getenv("APPDATA"|"LOCALAPPDATA"|"USERPROFILE"|"HOME"|"TEMP"|"TMP")` outside an allowlist. The allowlist is read-only uses, each with a reason:
    - `core/workspace` resolve;
    - `core/deps/detect.go` (finding system tools);
    - `core/focus/policy.go` and `modules/focus/apps.go` (OS folders and installed apps).
- **The AI engine's temp files.** The sidecar and every subprocess get `TMP`/`TEMP`/`TMPDIR` = `<support>/tmp`, plus `<support>/cache/numba`. A test checks the env `core/proc` and `core/sidecar` build.
- **Two instances sharing the tools folder** (Personal plus a sandbox without `TOOLBOX_TOOLS_DIR`):
  - installs, updates, removes, `uv sync` and tools-folder moves take an OS file lock, `<tools>/.toolbox-tools.lock`;
  - a second instance waits up to 2 s, then shows "Another Toolbox is changing the tools — try again in a moment";
  - reading tools and models needs no lock.
- **First-run setup.** A new workspace never shows the setup wizard. Its pack status comes from the shared tools folder.
- **Pack status after an install elsewhere.** `deps-cache.json` moves to the tools folder, so Personal sees what Demo installed. Each launch re-checks stale entries as today.
- **Focus during a switch.**
  - Switching costs the quit friction (at Strict: Emergency unlock).
  - Personal's session resumes when Personal opens again, and ends then if its time has passed (as after a restart).
  - Demo never enforces Personal's session.
- **Schedules and watch folders.** They belong to their workspace, so they don't fire while another workspace is open. On return they catch up under the existing rules (Phase 18).
- **The clipboard recorder.** It runs only in the instance that's open, with that workspace's setting (off by default in a new workspace).
  - **Capture:** the harness's clipboard scene refuses to run while another `toolbox.exe` that it didn't start is running, because a Personal recorder would store the test strings. It reports the skip.
- **Overlapping folders.** A workspace root may not be inside, or contain, the global support dir, the tools folder, Personal's library or another workspace's root. Personal's library setting refuses a folder inside a workspace root.
- **Names.** Workspace names are unique (case-insensitive). "Personal" is reserved.
- **A missing workspace folder** (an unplugged drive, or deleted outside the app). Boot falls back to Personal with a notice ("Demo's folder isn't there"), and the entry is marked `Missing` (Reveal disabled, Remove still available).
- **A corrupt `workspaces.json`.** It's kept as `.bak`, Personal opens, and a warning is logged and shown once.
- **A corrupt or missing `.toolbox/workspace.json` in a listed root.** The entry is shown as Missing; Add existing repairs it.
- **Seed and restore while files are locked** (Windows). Those files are skipped and named in the job result. Copies keep the source's modification time.
- **Present mode and native paths.** Notifications, the tray and error toasts go through the `Presenter`. Logs keep real paths, because they stay on this machine.
- **WebView storage under `wails3 dev`.** Each workspace still has its own profile directory, so origins can't share storage.
- **Migrations.** A new workspace DB runs all migrations from 0001. Personal's DB is untouched by this phase except for new migrations, if any.

## A7. Dev and demo tasks
- `wails3 task dev:sandbox` is unchanged, and it is the **Dev** workspace.
- New: `wails3 task dev:workspace WS=<root>` runs `wails3 dev` with `TOOLBOX_WORKSPACE`, `TOOLBOX_TOOLS_DIR=.dev/support` and dry-run Focus.
- **The demo workspace you'll use:** `<repo>/workspaces/demo`, kind Demo, baseline `<repo>/demoAssets`, Present on. Wave 3 creates it. You add it to Personal's list once with Settings → Workspaces → **Add existing folder…**, or by running `bin/toolbox.exe --workspace <repo>/workspaces/demo`.

---

# Part B — The Video Editor at practical parity

Everything in `frontend/src/editor/` serves both the Video Editor (`video-studio`) and Edit Studio, so Edit Studio gets all of it too.

## B0. Document v2 (`modules/editstudio/document.go`, frozen in Wave 0)
- `EditProject.Version` = 2.
- The reader migrates v1 on load:
  - `ExportHeight` stays the export size (now also 2160); every new field is optional (`omitempty`), and its zero value means v1 behaviour;
  - `Clip.Volume` stays the base gain;
  - nothing else changes.
- Track changes:
  - `Track.Kind` adds `"audio"`;
  - new `Track.Solo bool` and `Track.Height string` (`"s"|"m"|"l"`, `""` = `m`);
  - the track limit is 1..12, at most 8 video/adjust tracks.
- `Clip.Kind` adds `"audio"`, which is allowed only on audio tracks. `Path` can be any audio file or any video file; only its audio is used.
- New clip fields:
  - `Gain string`: EditParam JSON, keys only, in dB −60..+12, `""` = 0 dB. Effective gain = `Volume × dB(Gain(t))`. The inspector shows one **Volume (dB)** control. On first edit it folds `Volume` into `Gain` and sets `Volume = 1`.
  - `FadeInMs, FadeOutMs int64`: 0..10,000, audio only. They replace the fixed 10 ms de-click, which still applies when a fade is 0.
  - `Link string`: clips that share a Link move, trim, split and delete together.
- `EditProject.FPS` allows 24 | 25 | 30 | 60.
- `EditProject.Export *ExportSettings`:
  ```go
  type ExportSettings struct {
      FPS       int    `json:"fps"`       // 0 = project
      Codec     string `json:"codec"`     // "h264" | "h265"
      Quality   string `json:"quality"`   // "draft" | "good" | "best" → CRF 26 / 20 / 16 (h265: +4)
      AudioKbps int    `json:"audioKbps"` // 128 | 192 | 320
      InMs      int64  `json:"inMs"`      // range; 0/0 = whole
      OutMs     int64  `json:"outMs"`
  }
  ```
- These stay inside the frontend-owned JSON strings, with no Go change:
  - crop (`Transform.crop`);
  - key effects (`Effects`);
  - ease curves (`EditParam` keys);
  - Video Editor markers, which reuse `Markers.Custom` with songMs = timeline ms when there is no song.

## B1. Playback clock and preview audio (`editor/audio/`, new)
- **Clock.** `PlaybackClock` runs on `AudioContext.currentTime` and works **with or without a song**.
  - Project length is the latest clip end, or the song length if that's longer.
  - Play at the end restarts from the start.
  - The playhead store is updated once per animation frame (not per `timeupdate`).
  - Subscribers that need coarse time use `usePlayheadCoarse(ms)` (throttled).
- **Preview audio for every source.** The prepare job (`runPrepare`) also writes `audio.m4a` (AAC 96 kb/s, 48 kHz stereo) and `peaks.bin` into the source's cache dir. `peaks.bin` holds min/max per 10 ms as int8 pairs, with the header `{"v":1,"rate":100,"channels":1}` as the first line.
  - Audio-only files (mp3, wav, flac, m4a, ogg, opus) get just these two files, with no H.264. `PrepareRequest` and `Sources` accept them.
  - `SourceState` gains `Audio string` (the `audio.m4a` path, `""` = none or not made yet) and `Peaks string`. `Info.HasAudio` already says whether there is sound.
- **Mixer.** A Web Audio graph:
  - **Per clip:** `AudioBufferSourceNode` → gain node (`Volume`, `Gain` keys as `setValueCurveAtTime`, fades) → track gain (mute/solo) → master → destination.
  - **The song** is one more source with its gain and fades. The hidden `<audio>` player is removed.
  - **Scheduling:** sources are scheduled 200 ms ahead and rescheduled on seek or edit.
  - **Speed:** speed ≠ 1 sets `playbackRate` per constant-speed segment. Pitch follows the rate. The export keeps pitch, through `atempo` as today (noted in the inspector tooltip).
- **Loading.** `lib/wholeFile.ts` generalises `wholeImageUrl`: it fetches a media URL in ≤ 4 MiB ranges and joins them.
  - Buffers are decoded with `decodeAudioData` and kept in an LRU of decoded audio, capped at 512 MB.
  - A source that isn't decoded yet is silent and shows a small "loading audio" dot on its clips.
- **Scrub audio.** While dragging the playhead, it plays 60 ms grains. It's on by default and can be toggled in the View menu.
- **Export.** `modules/editstudio/audio.go` mixes everything:
  - the song;
  - the audio of every unmuted video clip (Volume and Gain);
  - every audio clip.

  Per clip: `atrim`/`asetpts` → the existing speed chain → `volume='<piecewise linear dB→gain expr>':eval=frame` → `afade` in/out → `adelay`. Then `amix=normalize=0` and `alimiter=limit=0.98`. Solo and mute follow the preview.

## B2. Timeline (`editor/timeline/`)
- **Ruler.** It sits on top of the tracks in both editors, above Edit Studio's lanes.
  - Timecode ticks adapt to the zoom (frames → seconds → minutes).
  - Click seeks and drag scrubs.
  - Marker flags appear on it: **M** adds one, double-click names it, drag moves it, and **[ / ]** jump between them. In Edit Studio, [ / ] keep their lane meaning.
  - **I / O** set a range, shaded on the ruler, used by export and loop play (**Shift+L**). **Alt+X** clears it.
- **Timecode readout** in the transport (`HH:MM:SS:FF`). Click to type a time; Enter seeks.
- **Zoom:**
  - **=** / **−** zoom around the playhead; **\\** fits; a zoom slider sits in the timeline toolbar.
  - **Ctrl+wheel** (and trackpad pinch) zooms at the pointer, the plain wheel scrolls tracks vertically, and Shift+wheel pans. This changes today's plain-wheel zoom, and the change goes in DECISIONS.
  - The zoom range is 6–2,000 px/s, which reaches single frames at 60 fps.
- **Track headers:**
  - name (double-click to rename);
  - mute, **solo**, lock;
  - a volume fader on audio tracks;
  - height S/M/L, by dragging the header's bottom edge or from the context menu;
  - **Add ▸ Video track / Audio track / Adjustment track**.

  Dropping a source below the last track or above the top track creates a track.
- **Waveforms** on audio clips and on video clips with audio, at heights M and L, drawn from `peaks.bin` into a canvas per visible clip (bounded, visible only).
- **Tools** (a toolbar segment plus keys, as in Premiere):

| Key | Tool | Behaviour |
|---|---|---|
| V | Select | today's move/trim/marquee |
| C | Razor | click splits that clip at the pointer (snaps); Shift+click splits every unlocked track |
| B | Ripple trim | dragging an edge shifts later clips on that track |
| N | Roll | dragging the cut between two touching clips moves both edges |
| Y | Slip | dragging inside a video clip shifts `InMs` (the inspector shows the new in/out, and the preview shows the in frame during the drag) |

- **Editing:**
  - **Delete** leaves a gap.
  - **Shift+Delete** is ripple delete.
  - Selecting a gap (click the empty space between clips) and pressing Delete, or right-click → **Close gap**, closes it.
  - **Ctrl+C / Ctrl+X / Ctrl+V** paste at the playhead on the target track (overwrite). **Ctrl+Shift+V** pastes as an insert (ripple). **Alt+drag** duplicates.
- **Overwrite vs insert.** Moving or dropping a clip onto another one now **overwrites**: the clip underneath is trimmed or split. Today the move is refused. Holding **Ctrl** while dropping **inserts**: later clips on that track shift right. Locked tracks never change.
- **Linked clips:**
  - Context menu → **Detach audio** creates an audio clip on the first free audio track (and makes one if there's none) with the same timing, `InMs` and speed. It sets the video clip's `Volume` to 0 and links the two.
  - Linked clips select, move, trim, split, ripple and delete together.
  - Alt+click selects one side only. **Ctrl+L** links or unlinks the selection.
  - Linked clips show a small chain mark.
- **Keyframes on the timeline.** At track height M or L, a selected clip shows a **keyframe strip** under it: one diamond per keyed time, merged across its params.
  - Drag moves every key at that time; Alt+click deletes them; double-click opens that param in the inspector.
  - **Alt+[ / Alt+]** jump to the previous or next key of the selected clip.
- **Volume line.** Audio clips (and video clips with audio at height L) show the `Gain` as a line.
  - Drag it up or down to set the gain at the pointer (or set the whole clip when it has no keys).
  - Ctrl+click adds a key. Fade handles at the top corners drag `FadeInMs`/`FadeOutMs`.
- **Snapping** gets a magnet toggle and **Shift+N**. Alt still bypasses it while dragging.

## B3. Keyframe easing (`viz/edit/params.ts`, `viz/edit/types.ts`)
- `Key.ease` adds `"in" | "out" | "inout" | "bezier"`, with `Key.bez?: [x1, y1, x2, y2]` (0..1 x, −1..2 y). `"ease"` keeps today's smoothstep.
- The picker in `KeyframeToggle` shows these choices:
  - Linear, Hold, Ease in, Ease out, Ease in-out, Smooth;
  - **Custom**: a 120 × 80 curve editor with two handles.
- Evaluation is deterministic: cubic-bezier solved by Newton with a bisection fallback, with golden tests.

## B4. Overlays, crop and keys
- **Picture-in-picture presets** in the Transform panel:
  - Full;
  - Top-left / Top-right / Bottom-left / Bottom-right at 30% with a 4% margin;
  - Centre 50%;
  - Left half / Right half.

  Each sets x, y and scale; at the playhead when the property is keyed.
- **Crop.** `Transform.crop {l, r, t, b}`, each an EditParam 0..0.45 and keyframable.
  - On the preview, the Crop button (or Alt+drag on a handle) drags crop edges.
  - Crop applies in `ClipRenderer` before masks and the transform.
- **Chroma key** (`viz/post/chromakey.ts`, a `registerPost` pass, catalog group "Key"):

| Param | Range | Default when added |
|---|---|---|
| `color` | colour | `#00b140` (picked with the eyedropper) |
| `similarity` | 0..1 | 0.18 |
| `smoothness` | 0..1 | 0.08 |
| `spill` | 0..1 | 0.5 |
| `choke` | −1..1 | 0 |
| `view` | composite / matte / source | composite |
| `amount` | 0..1 | 1 (0 = exact identity) |

- **The chroma key math:**
  - Distance in the CbCr plane (BT.709), with luma weighted 0.25; alpha = smoothstep(similarity, similarity + smoothness, d).
  - Spill: the key's dominant channel is clamped toward the max of the other two, by `spill`.
  - Choke: one 3 × 3 erode (−) or dilate (+) pass on alpha, scaled.
  - Output is premultiplied.
- **Eyedropper.** The "Pick" button next to the colour, then a click on the preview. It averages a 5 × 5 patch of the clip's own **pre-effect** source pixel under the pointer (through the engine's `samplePre(clipId, x, y)`).
- **Luma key** (`viz/post/lumakey.ts`): `threshold`, `softness`, `invert`, `amount`.
- **One-click stack** "Green screen" in `FxStacks.ts`: chroma key + choke 0.1 + spill 0.6. Masks still apply as garbage mattes, because mask alpha and key alpha multiply.

## B5. Seeking and preview (`viz/frames/`, `viz/edit/EditCanvas.tsx`)
- **Read-ahead while paused.** After 150 ms idle, decode ±0.5 s around the playhead for the visible clips. It's cancelled by any seek.
- **Back-step cache.**
  - Decoded frames of the current and previous GOP are kept as `ImageBitmap`s.
  - The cache is an LRU of at most 256 MB, freed on project close.
  - **,** / **←** step back without a decoder reset when the frame is cached.
- **Reverse play (J).** It plays backward at 1×, 2× and 4× from the cache, decoding GOP by GOP ahead of the reverse playhead. If it can't keep up, it drops frames (never stalls). K stops.
- **Edit points.** **↑ / ↓** jump to the previous or next edit point (clip edges on all tracks). **Shift+← / →** jump 1 second.
- **Preview quality.** **Draft** (preview tier, default) or **Full** (export tier, for checking keys and text) in the preview bar. Full during playback may drop frames, and a small "Full" chip shows while it's on.
- **No wasted work.** `EditCanvas` calls `engine.setEdit` only when the compiled edit changes (by identity), never per frame.
- **"Preparing".** Clips still being prepared show a progress bar on the clip, and the preview shows the last good frame, not black.

## B6. Export (`editor/export/ExportDialog.tsx`, `modules/editstudio` render)
- **The dialog** has these fields:
  - Size (720 / 1080 / 1440 / 2160);
  - Frame rate (Project / 24 / 25 / 30 / 60);
  - Format (H.264 MP4 / H.265 MP4);
  - Quality (Draft / Good / Best);
  - Audio (128 / 192 / 320 kb/s);
  - Range (Whole / In–Out, disabled without a range).

  It shows an estimated size, from the bitrate class × duration.
- **Two extra actions:**
  - **Audio only (.m4a)**: the mix only, no render.
  - **Still frame (.png)** of the playhead at the export size.
- Settings are saved in `Export`. Results end in `LastExport` as today.

## B7. Markers and the shortcut table
- The Video Editor gets markers (§B2).
- `EDIT_SHORTCUTS` is the single table: the new keys go there, and the "?" overlay lists them.
- New keys:
  - tools: V C B N Y;
  - **= − \\**;
  - I, O, Alt+X;
  - Shift+L, Shift+N;
  - Shift+Delete;
  - Ctrl+C/X/V, Ctrl+Shift+V, Ctrl+L;
  - ↑ ↓, Shift+← →;
  - Alt+[ Alt+];
  - M (Video Editor only: the ruler binds it like Edit Studio's Lanes do, so it isn't in the shared table).

  A test fails on a duplicate combo within the same scope.

## B8. Errors and limits
- **Audio decode fails:** the clip plays silent with a warning badge ("Couldn't load this clip's sound — export still includes it"), and a log line is written.
- **Decoded audio over the 512 MB cap:** the least recently used sources are dropped, and they reload on demand.
- **Paste over a locked track:** refused with a toast. **Overwrite that would split a linked clip:** splits both sides.
- **Exporting a range shorter than one frame:** a validation error.

## B9. Tests
- **Pure, table-tested:**
  - ops (overwrite, insert, ripple delete, close gap, roll, slip, paste, link, detach);
  - easing (bezier goldens);
  - peaks parsing;
  - the gain-expression builder (Go);
  - the v1 → v2 migration (Go);
  - the shortcut-uniqueness test.
- **Engine:** chroma key and luma key on synthetic frames, where a green square becomes alpha 0 and skin-tone pixels keep alpha 1 at the defaults; `amount` 0 is identity; crop.
- **Mixer** with a fake `AudioContext`: scheduling, mute/solo, fades, keys.
- **Go:** export mixing against the fake-ffmpeg re-exec helper (args snapshot); prepare writes `audio.m4a` + `peaks.bin` (integration, real FFmpeg).
- **Architecture:** `src/editor/` still imports nothing from `src/tools/`.

## B10. Performance targets (demo footage, 1080p30 sources, preview tier, this PC)
- Click-seek to a displayed frame: p95 ≤ 120 ms.
- A cached back-step: ≤ 16 ms. An uncached one: ≤ 120 ms.
- Scrubbing updates the picture at ≥ 20 fps.
- Playback of 3 stacked video tracks plus a keyed clip runs at the project fps with ≤ 1% dropped frames.
- Audio starts within 50 ms of the picture and stays within ±1 frame.

## B11. Acceptance (the real build, on the demo footage)
1. **A 3-minute 16:9 cut:**
   - A-roll on V1, B-roll on V2 as a corner PiP (preset, then keyframed in from off-screen with Ease out);
   - the green-screen clip keyed over a background with the eyedropper and the Green screen stack;
   - a song on A1 at −14 dB with a fade-out, and its volume dipped (two keys) under a talking clip;
   - detach one talking clip's audio and move the video alone (Alt+click);
   - razor, ripple delete, close gap, roll and slip once each;
   - copy and paste a clip;
   - export 1080p30 H.264 Good.
2. **The export matches the preview:**
   - key, PiP path and volume dip;
   - audio in sync (a clap-test clip, within ±1 frame);
   - no clicks at cuts.
3. **Without a song:** Play works, and clip audio is heard in the preview.
4. **Other checks:**
   - the B10 targets are measured, with numbers in DECISIONS;
   - Edit Studio still passes its Phase 9 checks;
   - screens at 1180 × 720 and 960 × 600, light and dark.

---

# Part C — A calmer, more human Visualizer

## C1. The motion grammar (what "human" means here)
A good VJ doesn't react to everything. Big changes follow the **song's form**, and small ones follow the **groove**.

| Tier | Driven by | May change | Rate and size |
|---|---|---|---|
| **Breath** | Phrases and sections (`section.energy` ramped, `bar.pulse` every 4 bars, drops) | Scene, palette, density, camera, whole-frame posts | At most once per 4 bars (drops excepted), blended over ≥ 1 bar |
| **Groove** | Beats, `bass.level` with a slow release | Scale/glow "breathing", gentle sway | ≤ 4% of the parameter's range per beat; smooth envelopes (≥ 250 ms release) |
| **Accent** | Hits (`kick`, `snare`, `hats` pulses) | **Small, local elements only**: particles, sparkles, a ring, line thickness | Never the whole frame; never the camera; never the palette |

**Stem roles** (the default mapping in every retuned preset):
- **drums:** accents;
- **bass:** groove breathing;
- **vocals:** the focal element (lyrics, a centre glow) and **ducking**: while vocals are present, background busyness drops by up to 30%, so the eye has a place to rest;
- **other** (harmony): colour and texture drift.

## C2. Engine fixes (`frontend/src/viz/`)
1. **Integrate rates; don't multiply them.**
   - The new `f.integral(param, opts?)` returns ∫₀ᵗ of the parameter's effective value (base plus mods, envelopes included) in parameter·seconds. It's computed at 1/120 s steps in a prefix cache keyed by (layer instance, param, show hash) that is extended lazily and kept on backward seeks. It is deterministic, so the export worker gets the same values.
   - `f.beatIntegral(param)` is the same thing measured in beats (it integrates `param × local beats per second`).
   - **Every layer that multiplies a speed or spin by time, beats or bars uses them.** That covers:
     - `starfield`, `tunnel`, `synthgrid`, `kaleido`, `ribbons`;
     - `lissajous`, `vortex`, `ink`, `gradient`, `nebula`;
     - `geometry`, `radial`, `wavering`, `helix`;
     - `bursts`: particles keep the speed they were born with.
   - A test fails if a layer's output moves more than a threshold between two frames 1/60 s apart while a speed mod steps from 0 to 1.
2. **Envelope defaults by signal class** (`SIGNAL_CLASS_DEFAULTS` in `signals.ts`). A mod's explicit attack/release still wins.

| Class | Signals | Attack / release |
|---|---|---|
| pulse | kick, snare, hats, beat, onsets | 10 / 180 ms (unchanged) |
| level | `*.level`, `mix.*` | 60 / 400 ms |
| slow | `section.energy`, `mood.*`, `line.active`, `vocals.presence` | 600 / 1,500 ms |

   - The `drums.level` fallback without stems becomes the mix's low-band **level**, not `mix.onset`.
   - Layers that read `f.signals.value()` raw (`vortex`, `text/index.ts:314`) go through the enveloped reader.
3. **`section.energy` ramps.** It moves linearly over one bar centred on each boundary, never as a step.
4. **One master Intensity reaches everything.** `show.reactivity` (0–2) scales:
   - preset mods (today's behaviour);
   - every layer's built-in `drive()` reaction;
   - the posts that read signals directly (shake, zoompulse, chromatic, glitch);
   - event layers (shockwave, ripples, bursts: amount and count);
   - transition flash strength;
   - palette churn (C2.6).

   The UI shows it as **Calm (0.5) / Balanced (1) / Wild (1.5)** stops plus the fine slider. Retuned presets look right at **Balanced**, the default.
5. **Director:**
   - **Minimum scene hold:** 8 bars in section mode (drops excepted).
   - **Drop rate limit:** a drop less than 8 bars after the last one counts as a lift. This is decided in TS, so no re-analysis is needed.
   - **Morph instead of crossfade.** When the next scene uses the same layers, its base parameters **morph** over 2 bars with ease-in-out. Two pictures are crossfaded only when the layer sets differ.
   - **Feedback buffers** are cleared with a 0.5 s fade when a scene is re-entered (no stale frames from minutes ago).
6. **Palette:**
   - **`chords` mode:** only accents rotate, by at most ±30°, over 1 bar. A chord must hold for 2 beats before it counts. The background never rotates.
   - **`mood` mode:** a minimum hold of 8 bars, a 4 s blend, and a move to a neighbouring palette only (a mood wheel order), never across it.
7. **Posts:**
   - **Shake noise:** 24 Hz → 5 Hz; amplitude ≤ 1% of the short side at Balanced.
   - **Zoom pulse:** on bars, not beats, ≤ 3%.
   - **Chromatic split:** drops only.
   - **Downbeat shockwave flashes:** removed; the shockwave remains, every 4 bars, with no flash.
   - **Drop flash peak:** 1.6 → 1.0, and only on the drops that pass the rate limit.
   - **Double reactions** (a preset mod plus the shader's own `u_kick` on the same visual) are removed. The shader's built-in reaction is the one kept.

## C3. Preset retune (`viz/presets/**`)
- **Every preset** is rewritten to the grammar (C1) and its stem roles.
- **Every preset keeps its identity:** its layers, look and palette idea. Only motion and reactivity change.
- **The worst offenders get the most care:**
  - Warp Drive, Tunnel Run, Kaleido Bloom, Synthwave, Neon Highway;
  - Silk Waves, Oscilloscope Lab, Nebula;
  - then Vortex, Radial Pulse, Particle Storm.
- **Grammar lint** (`presets/grammar.test.ts`) checks every preset and every scene:
  - mods on rate params (speed, spin, travel, drift) have |amount| ≤ 0.15;
  - accent-class signals never drive camera posts, palette or whole-frame layers;
  - whole-frame posts trigger at most once per bar except on drops;
  - there are ≥ 3 controls (today's rule).
- **Edit Studio's "visual" clips and marker-driven effects** use the same posts, so they get calmer too. Effect params a user set by hand keep their values; only the posts' internal shake rate and flash peak change. This is noted in DECISIONS.

## C4. Motion metric (VizLab, `viz/lab/`)
- `TOOLBOX_VIZLAB_MODE=motion` renders each preset for 30 s at 60 fps from 30% of the song, using the real `song.main` analysis when given with `TOOLBOX_VIZLAB_KEY`, else the fixture.
- Each frame is downsampled to 64 × 36, and the results go to `motion.json` per preset:
  - `flashMaxPerSec`: WCAG 2.3.1 general flashes (pairs of opposing relative-luminance changes ≥ 10% where the darker is < 0.80), the maximum in any 1 s window, measured on the frame mean and on a 4 × 4 grid (worst cell);
  - `meanDelta` and `p95Delta`: per-pixel |ΔL| between consecutive frames, 0..1;
  - `teleports`: frames where the correlation between consecutive frames is < 0.5, outside a scene transition window;
  - `hueChurn`: mean |Δ dominant hue|, in degrees per second;
  - `busyness`: mean optical-flow magnitude proxy (block SAD).
- `motion-sheet-<preset>.png` shows 24 frames, one per 1.25 s, for eyeballing.
- **"Before" numbers** are measured on main at Wave 0 and committed as `frontend/src/viz/lab/motion-before.json`.

## C5. Tests
- The layer continuity test (C2.1).
- Envelope classes.
- `section.energy` ramp.
- Director hold, rate limit and morph (`director.test.ts`).
- Palette hysteresis.
- Grammar lint.
- VizLab hash goldens are regenerated (expected, recorded).

## C6. Targets and acceptance
1. **Every preset at Balanced, on `song.main` and on the fixture:**
   - `flashMaxPerSec` ≤ 3 (hard);
   - `teleports` = 0 (hard);
   - `p95Delta` ≤ 50% of before, or ≤ 0.04 absolute;
   - `hueChurn` ≤ 15°/s.
2. **At Wild:** flashes ≤ 3/s and teleports = 0 still hold.
3. **Calm vs Wild:** Calm's `busyness` is ≤ 60% of Wild's.
4. **Before/after renders.** 15 s of the 8 worst offenders, before and after, side by side, go into `Demo Footage/Visualizer before-after/` for you to judge. Your sign-off is the real acceptance. If you don't like a preset, I retune it in a follow-up.
5. **Performance.** The fps probe is no worse than 5% from before.

---

# Part D — The demo footage

## D1. The harness (`demo/`, committed)
```
demo/
  README.md              how to run, roles, adding a scene
  roles.json             role → files in demoAssets (Wave 3)
  run.mjs                node demo/run.mjs [--only 08,12] [--list] [--fresh] [--no-record] [--port 9230]
  capture/
    app.mjs              launch bin/toolbox.exe with the capture env; stop it by PID tree (never by name)
    cdp.mjs              CDP over Node's built-in WebSocket; targets; eval; input
    record.mjs           Page.startScreencast → timestamped JPEG frames → FFmpeg CFR mp4
    cursor.js            injected overlay: arrow cursor, eased moves, click ripple, key-chip captions
    act.mjs              scene API (below)
    shotlist.mjs         shotlist.json + shotlist.md
  scenes/NN-<id>.mjs     one per clip (export default {id, title, tool, roles, kind: "a"|"b"|"still", run(t)})
```
- **Capture env:**
  - `TOOLBOX_WORKSPACE=<repo>/.dev/workspaces/demo-capture` (seeded fresh from `demoAssets` with `--fresh`);
  - `TOOLBOX_WORKSPACE_KIND=demo`, `TOOLBOX_WORKSPACE_NAME=Demo`;
  - `TOOLBOX_TOOLS_DIR=<repo>/.dev/support` (the sandbox's complete tools; your Personal tools are never touched);
  - `TOOLBOX_DEVTOOLS_PORT`, `TOOLBOX_FOCUS_DRYRUN=1`, `TOOLBOX_NO_HOTKEYS=1`.

  It runs the production binary (`wails3 build`), not the dev server.
- **Frame:**
  - `Emulation.setDeviceMetricsOverride` 1920 × 1080 at DPR 1;
  - JPEG quality 92 screencast;
  - frames placed by their `metadata.timestamp` → FFmpeg concat with durations → `fps=30` → libx264 CRF 16, `preset slow`, yuv420p, `+faststart`.

  The screencast records **only the page**, never the desktop or other windows, and works while the window is covered.
- **Cursor overlay.** A neutral arrow with a soft shadow.
  - It moves in 350–700 ms by distance, on a cubic ease.
  - Each click shows a ripple; a key press shows a chip for shortcuts ("Ctrl+K").
  - It's injected with `Page.addScriptToEvaluateOnNewDocument` **only by the harness**. Nothing ships in the app.
- **Scene API (`t`):**
  - **Recording:** `t.rec.start()/stop()`, `t.hold(ms)`, `t.handles()` (1.5 s still at both ends).
  - **Navigation:** `t.open(moduleId)`, `t.openLibrary(folder?)`.
  - **Input:**
    - `t.click(sel|text)`, `t.drag(fromSel, toSel)`;
    - `t.type(sel, text)` at 12–18 characters per second with seeded jitter;
    - `t.key(combo)`, `t.scroll(sel, dy, ms)`.
  - **Files:**
    - `t.handOff(moduleId, roles…)` delivers files the way a drop would;
    - `t.pickFromLibrary(role)` uses the in-app Library picker;
    - **native dialogs are never opened.**
  - **Jobs:** `t.waitJob({ compress: true })` pauses recording while a long job runs and inserts a 0.4 s dissolve. The shot list notes "time compressed 3:12 → 0:01".
  - **Stills:** `t.still(name)` takes a PNG.
  - **Notes:** `t.note(text)` adds a line for the shot list ("what's shown", plus a suggested voice-over line).
- **Safety in scenes:**
  - The clipboard scene writes only its own test strings, reads the previous text first and restores it.
  - Local File Transfer is filmed with **receiving off** (the send screen and the pairing explanation only).
  - Focus runs as a dry run, so the pill and countdown show but nothing is stopped.
  - The two network scenes use only the fixed Wikimedia URLs in `roles.json`.

## D2. Scene list (A-roll: one process per clip, 8–40 s after compression, 1.5 s handles)

| # | Clip | Shows (on which media) |
|---|---|---|
| 00 | Tour | Sidebar categories, palette search ("stems"), drop `song.main` → suggested tools |
| 01 | Library | Folders, HEIC previews, lineage of a result, Things view |
| 02 | Smart search | "ferris wheel", "rain at night", "dessert", "code", a phrase from `video.talk`, Find similar on the skyline |
| 03 | Stems | `song.main` → 4 stems, solo vocals |
| 04 | BPM & key | the Paramore and underscores stems → tempo/key, renamed copies |
| 05 | Audio to MIDI | Paramore bass stem → MIDI, piano roll |
| 06 | Visualizer | `song.main` → Balanced preset, Intensity stops, a design tweak, render |
| 07 | Lyric Video | `song.main` → timed lyrics → render preview |
| 08 | Edit Studio | B-roll + `song.short` → Cut to the beat → play |
| 09 | Video Editor I | multitrack: razor, ripple, `Wally` keyed (blue) as a keyframed PiP with ease |
| 10 | Video Editor II | `Snoop Dog Dancing` keyed with the eyedropper over the rainy street, matte view → composite; `Shitty Explosion` with screen blend |
| 11 | Video Editor III | audio: detach, volume dip under the narration, fades, export dialog |
| 12 | Transcribe | `video.talk` → transcript, click a word to seek |
| 13 | Subtitles | generate, style, burn in |
| 14 | Silence Cutter | `video.talk` → pauses removed (before/after timeline) |
| 15 | Audio Cleanup | `audio.noisy` → clean (A/B toggle; the waveform shows the change) |
| 16 | Text to Speech | article paragraph → voice |
| 17 | Local Chat | ask about `doc.pdf` |
| 18 | Caption Writer | 6 photos → alt text, captions, hashtags; Write into copies |
| 19 | OCR | drum chart and the code screenshot → text, copy |
| 20 | PDF Toolkit | merge, reorder pages, compress |
| 21 | Document Converter | `.md` → PDF and DOCX |
| 22 | Converter | `Round Winning Kill.wmv` → MP4, `song.alt` → MP3 |
| 23 | Compress to Size | B-roll → "Discord" target |
| 24 | Trimmer | trim with keyframe preview |
| 25 | Scene Splitter | the B-roll reel → shots |
| 26 | GIF & Contact Sheet | `Snoop Dog Dancing` → GIF + sheet |
| 27 | Background Remover | the T-shirt photo → cut-out |
| 28 | Upscale | `rainbowfrog.gif` → 4× (before/after slider) |
| 29 | Object Eraser | the alley photo: brush the parked car away |
| 30 | Redact | the rainy street: plates and faces blurred |
| 31 | Metadata | inspect a Demo copy: location already stripped; strip the rest |
| 32 | Image Batch | 10 photos → web-sized WebP with a watermark |
| 33 | Organizer | photos → folders by date, look-alikes aside |
| 34 | Photo Composer | template → photos placed |
| 35 | Post Builder | carousel with a caption from Caption Writer |
| 36 | Paint+ | brush strokes (scripted) over the plover drawing, a Lab tool with its origin card |
| 37 | Pipelines | "Song to everything" graph runs, cells light up |
| 38 | Clipboard | history popup with test strings |
| 39 | Vault | add files, lock, unlock |
| 40 | File Transfer | send screen and pairing explanation (receiving off) |
| 41 | Focus Lock | Pomodoro profile, the pill counts down (dry run) |
| 42 | Dev Utilities | JSON format, hash, colour |
| 43 | Workspaces | the chip menu shows Demo and Dev; Settings → Workspaces |
| 44 | Downloader | a public-domain Wikimedia video URL → video |
| 45 | Web Archiver | a Wikipedia article → single HTML |
| 46 | Color Grader | the rainy street: Tasteful → Bonkers on the Wildness dial, Vibe "haunted vaporwave mall at 3 am", Neon Noir with subject regions, Depth Rainbow on the skyline, Chaos rerolls, export; then `Snoop` keyed + graded video |

**B-roll** (kind `b`):
- the app's own exports, 16:9:
  - every retuned Visualizer preset, 15 s on `song.main` / `song.alt` at 1080p60 with audio;
  - Lyric Video and Edit Studio renders;
  - **"Bonkers montage"**: 12 Color Grader looks on the photos and B-roll, 2 s each, made as a Video Editor export.
- a 20 s Paint+ time-lapse;
- a slow Library grid scroll;
- a pipeline graph running;
- the editor timeline playing;
- the stems waveforms.

**Stills:** a 1920 × 1080 PNG of every tool's finished state.

## D3. Delivery (into `<repo>/workspaces/demo`)
- `Library/Demo Footage/`:
  - `A-roll/NN Title.mp4`;
  - `B-roll/<name>.mp4`;
  - `Stills/NN Title.png`;
  - `Visualizer before-after/`;
  - `shotlist.md` + `shotlist.json`, one entry per file: #, file, tool, duration, assets used, what's shown, suggested VO line, time compressed?
- **"Demo — rough cut",** a Video Editor project in the Demo workspace at 16:9, 30 fps:
  - V1: the A-roll in shot-list order with 0.5 s crossfades;
  - V2: empty, for your B-roll;
  - A1: `song.alt` at −14 dB with a 3 s fade-out;
  - a ruler marker per scene, named.

  It's built through `EditStudioService` (no UI scripting) after the footage is copied in.
- `Demo Footage` and `Extras` are in the workspace's `keep` list, so **Tidy up** never removes it.

## D4. Acceptance
1. `node demo/run.mjs --list` lists all scenes with their roles and which assets are present.
2. A full run films every scene whose roles exist, without manual help. Each clip:
   - is 1920 × 1080, 30 fps CFR, H.264, plays in the Video Editor;
   - starts and ends on a still handle;
   - shows the tool going from input to result.
3. **I review every clip** (a contact sheet of 6 frames per clip) and re-shoot any with an error toast, a spinner over the end handle, a misplaced cursor or anything personal: a path outside `Demo/…`, a user name or a hostname.
4. A grep of all frames' OCR (Smart search's own OCR) for your user name, home path and hostname finds nothing.
5. The rough cut opens and plays in the Demo workspace.
6. Opening Demo shows nothing from Personal (§A acceptance).

---

## Part A tests and acceptance

**Tests:**
- `core/workspace`, table-tested:
  - resolve order and env vars;
  - the global tools folder;
  - validation (nested roots, a non-empty folder, a baseline inside the root);
  - `workspaces.json` round-trip, with corruption → Personal plus a logged warning;
  - Presenter rewrites.
- Seed, restore and tidy on `t.TempDir()`:
  - hidden files, symlinks and junctions skipped (Windows junction test);
  - nothing written to the baseline (its hashes are unchanged);
  - tidy keeps `keep` folders and baseline files.
- `dryrun.go` with `Sandboxed`.
- `instanceID` per workspace.
- Settings library lock.
- Frontend:
  - `displayPath` vectors;
  - the workspace chip and menu;
  - the Settings → Workspaces page, including the Personal row's disabled actions with reasons;
  - errors rewritten.

**Acceptance (real build):**
1. Personal opens exactly as before: same library, history, settings and tools. `workspaces.json` appears; nothing else changes.
2. Create **Demo** from `demoAssets`. Toolbox relaunches into it and the seed job copies every file. `demoAssets` hashes are unchanged.
3. In Demo:
   - Library, Recent, Pinned, job history, clipboard history, search, projects, pipelines, Vault and devices are all empty or default;
   - paths show `Demo/Library/…`;
   - the window title is "Toolbox — Demo";
   - File Transfer shows "Toolbox Demo".
4. Run Stems in Demo and switch to Personal: no trace of it. Switch back: the stems are there.
5. **Restore baseline** after deleting a baseline file brings it back. **Tidy** lists the stems and moves them to the trash; `Demo Footage` stays.
6. Both workspaces use the same tools folder, with no downloads.
7. Start at login opens Personal, even when Demo was last used.
8. Switching during a real (dry-run-checked) Focus session asks for the quit friction.
9. **Isolation fs-diff:** list every file (path, size, mtime) under `%AppData%\Toolbox`, `~/Toolbox`, `%LOCALAPPDATA%\Toolbox*` and `%TEMP%` (Toolbox-named entries) before and after a 10-minute Demo session that runs Chat, Stems, a pipeline, Clipboard (on), Vault, Paint+ and Color Grader. Only `workspaces.json` changes. Then Personal's Chat, job tray, log panel, Recent and pipelines show none of it.
10. Screens at 1180 × 720 and 960 × 600, light and dark.

---

# Part E — Color Grader (`grade`)

## E1. Product
- **Sidebar:** category "Photo & image", icon `palette`, tagline "Film looks to absolutely unhinged".
- **Accepts:** pictures (jpg, png, webp, gif (first frame), tiff, heic) and videos (anything FFmpeg reads, wmv included). Several files make a **batch**: the same look on each, one job per file.
- **Layout** (a workspace tool: `defineWorkspace`, `StudioLayout`):
  - **Centre:** the preview, with a before/after split you drag (`\` toggles it). Video gets a mini transport.
  - **Bottom strip:** the **look gallery**, live thumbnails of *your* picture in every look (160 px, rendered on one shared GL context, visible ones only), with tabs **Film / Bold / Bonkers / Mine**.
  - **Header:** the **Wildness** dial (Tasteful 0 → Bold 0.5 → Bonkers 1, default 0.5) and the primary **Export**.
  - **Rail** (each a `ClickIn` with a one-line summary):
    - **Look**: the op stack (per op: toggle, amount, region chip, drag to reorder, add an op);
    - **Vibe**;
    - **Read the picture**;
    - **Regions**;
    - **Steal a look**;
    - **Chaos**;
    - **Motion** (video);
    - **Export**.
- **Wildness:**
  - It scales every op's `amount` through the look's own curve (`wildCurve`: how its ops grow from Tasteful to Bonkers).
  - Above 0.66 it switches on the look's `chaos` ops, which are off below that. That's how Neon Noir gains edge glow and chromatic split only at Bonkers.
- **The 40 built-in looks** (`frontend/src/grade/looks/`, one file per tier):
  - **Film (12):** Clean, Warm Film, Cool Film, Teal & Orange, Bleach Bypass, Cross Process, Faded Matte, Seventies Slide, Golden Hour, Moonlight, Noir, Soft Pastel.
  - **Bold (12):** Cyberpunk, Miami Neon, Desert Heat, Arctic, Sepia Punch, Hyperreal, Lomo, Candy, Moody Forest, Blockbuster, Riso Duotone, Night Vision.
  - **Bonkers (16):**

| Look | Recipe idea |
|---|---|
| Aerochrome | infrared false colour: foliage goes magenta (channel swap) |
| Thermal | luma → ironbow gradient map; the subject runs hotter |
| Inferno by Depth | thermal gradient by depth; near is white-hot |
| Depth Rainbow | hue by depth |
| Acid Bath | hue cycle by luma + solarize + bloom |
| Oil Slick | iridescent hue by luma × depth + gloss |
| Neon Noir | subject in colour, background mono teal; Bonkers adds magenta edge glow and a chromatic split |
| Vaporwave Mall | pink/cyan gradient map, VHS, grain, pastel halation |
| X-Ray | invert, blue gradient map, edge glow |
| Toxic | green channel mix, halation, posterize |
| Pop Art | posterize 4, halftone, saturation 1.8 |
| Solar Flare | solarize, bloom, chromatic split |
| Deep Fried | contrast ×3, saturation ×3, sharpen, posterize, red cast |
| Dreamcore | lifted shadows, pastel gradient map, pink depth fog, glow |
| Midas | gold gradient map on the subject; background black and white |
| Glitch Prophet | glitch and channel shift on the background; the subject stays clean |

- **Vibe** (needs Local Chat; otherwise the `DepsGate` names the chat model):
  - A text box and **Write a look**. The chat model gets the op catalog (§E2) and the request, and returns a `GradeRecipe` constrained by `JSONSchema` (temperature 0.9, seed from the Chaos counter).
  - Go validates and clamps it (§E4). The look takes the name the model gives it.
  - **More like this** asks for 3 variations (seeds +1, +2, +3).
  - A request takes about 2–6 s, with a spinner and Cancel. Results go to the Look rail and can be saved.
- **Read the picture** (needs a vision model, as Caption Writer does):
  - It sends a 768 px still (the current frame of a video) and asks for 6 looks that fit this picture.
  - Each answer is `{name, why (≤ 90 chars), recipe}`, e.g. "Wet Neon — push the rain highlights magenta, sink the sky".
  - They appear as 6 extra gallery cards marked ✦.
- **Smart regions.** Any op can target one of these regions, with `feather` 0..1 and `invert`:

| Region | Comes from | Needs |
|---|---|---|
| all | — | — |
| highlights / shadows / midtones | luma (soft ranges) | — |
| subject / background | photo: the Background Remover model's alpha; video: Edit Studio's "people" matte | that model |
| people | the matte "people" mode (photo and video) | the matte model |
| near / far | **the new depth map** (`depth >= split`, soft; `split` 0..1) | **Color** pack (§E5) |

  - **Regions** shows each available map as a thumbnail. Clicking one shows it full size, and "View this map" puts it in the preview. Missing models show their install button in the `DepsGate`.
  - Maps are computed once per input and cached (§E5).
- **Steal a look:**
  - Pick a reference picture, from the Library or a file.
  - The `transfer` op matches the Lab mean and standard deviation per luma band (shadows, mids, highlights; Reinhard per band, with soft band weights).
  - The stats are computed in Go (`modules/grade/transfer.go`) and stored in the op's params, so the reference isn't needed again.
  - Its amount is 0..1.
- **Chaos:**
  - **Surprise me** builds a random recipe of 3–8 ops from the op catalog, weighted by Wildness (seeded mulberry32, `frontend/src/grade/chaos.ts`).
  - **Again** uses the next seed.
  - A 🔒 on an op keeps it across rerolls.
  - The seed is shown (`#4821`), and typing one in reproduces that look exactly.
- **Motion (videos):**
  - Ops with `anim` move over time: `huecycle` speed, `gradmap` drift, and a `pulse` (amount × a 0..1 wave).
  - **Beat sync** (optional): pulses land on beats or bars, using the Visualizer analysis of the video's own audio or of a chosen song (`viz.Analyzer`, which runs an analysis job).
  - Flash safety holds by construction (§E3.4).
- **Results** (the standalone rules, CLAUDE.md 2026-11-06):
  - **Export:**
    - Pictures go to `<library>/Graded/<name> (<look>).<ext>` in the same format at **full resolution**, oriented: JPEG q 92, PNG, or WebP q 90; HEIC becomes JPEG.
    - Videos become `.mp4`: H.264 CRF 18 at the source size (≤ 3840 on the long side) and the source fps, with the audio re-encoded to AAC 192k.
  - **Past exports:** the results list uses `ResultRow` (Reveal, Open, Save a copy, Send to).
  - **Save look** adds it to **Mine** (`<support>/grade/looks.json`, ≤ 200, through `GradeService`).
  - **Export .cube** writes a 33³ LUT of the look's **colour-only ops** (§E3.3) to `<library>/Graded/LUTs/<look>.cube`. The dialog lists what a LUT can't hold: regions, texture and motion.
  - **Video Editor:** saved looks appear in its effects menu under **Looks ▸** and insert the compiled effect stack (§E3.2).
- **Pipeline step "Grade with a look"** (`core.Chainable`):
  - It takes pictures or videos and produces graded files (role `graded`).
  - Options:
    - `look`: a built-in or saved look id;
    - `wild`: 0..1;
    - `seed`;
    - `vibe`: a template; when set, the LLM writes the look for each item;
    - `format`: "same" | "jpg" | "png" | "webp".
  - `Templates: ["/vibe"]`.
  - It renders through the main window, like Photo Composer's step, and waits with `ErrWaiting("Open Toolbox to render")` when there is none.
  - It has a `StepUI` and `paramDefs`.

## E2. The recipe (frozen in Wave 0)
`frontend/src/grade/types.ts`, mirrored by `modules/grade/recipe.go`. Both share the vectors in `core/testdata/grade-recipes.json`.
```ts
interface GradeRecipe {
  v: 1;
  name: string;             // ≤ 40 chars
  tier: "film" | "bold" | "bonkers" | "mine" | "ai";
  seed: number;             // u32
  wildCurve: "linear" | "late" | "early";
  ops: GradeOp[];           // ≤ 16
}
interface GradeOp {
  id: string;               // 6 chars, unique in the recipe
  kind: GradeOpKind;
  on: boolean;
  chaos?: boolean;          // active only at Wildness > 0.66
  amount: number;           // 0..1: strength at Wildness 1
  region: Region;
  params: Record<string, number | string | boolean | number[]>;   // per-kind schema (E3.1), clamped
  anim?: { speed: number; wave: "sine" | "saw" | "beat" | "bar" };  // video only; cycles per 10 s, 0.05..6
}
type Region =
  | { kind: "all" }
  | { kind: "highlights" | "shadows" | "midtones"; soft: number }
  | { kind: "subject" | "background" | "people"; feather: number; invert?: boolean }
  | { kind: "near" | "far"; split: number; feather: number };
```

## E3. Rendering (`frontend/src/grade/`, on the editor's engine)
1. **The op catalog** (`grade/ops.ts`). Each kind has a label, a params schema (ranges and defaults), `colorOnly`, `animatable`, and a pure-TS **reference function** (`grade/math.ts`) that the GLSL mirrors.

| Kind | colorOnly | Params (short) |
|---|---|---|
| `balance` | ✓ | exposure −3..3, temp ±1, tint ±1, contrast 0..3, pivot, saturation 0..3, vibrance ±1 |
| `wheels` | ✓ | lift/gamma/gain RGB (±1), offset |
| `curves` | ✓ | master + R/G/B, 5 points each (monotone cubic) |
| `hsl` | ✓ | 6 hue vectors × (hue ±180°, sat ±1, lum ±1) |
| `split` | ✓ | shadow colour, highlight colour, balance |
| `gradmap` | ✓ | 2–8 stops (`#hex`@pos); source luma / depth / hue; blend; drift |
| `chanmix` | ✓ | 3×3 matrix + bias; presets Aerochrome, BRG, GBR, mono-red |
| `solarize` | ✓ | threshold, mix |
| `posterize` | ✓ | levels 2..16 |
| `invert` | ✓ | per channel |
| `huecycle` | ✓ (static) | by luma/depth/radius, cycles 0..8, phase |
| `transfer` | ✓ | Lab stats × 3 bands |
| `bleach` | ✓ | mix |
| `glow`, `halation` | | radius, threshold, tint |
| `edgeglow` | | Sobel strength, colour, thickness |
| `depthfog` | | colour, start, density (needs depth) |
| `tiltshift` | | focus depth, range, blur (needs depth) |
| `grain`, `vignette`, `chromatic`, `halftone`, `glitch`, `vhs`, `sharpen`, `mirror` | | the existing `viz/post` passes and their params |

   - **The colour pass.** All colour-only ops compile into **one** `gradelook` pass: a shader with a uniform block per op, run in recipe order. Each op blends as `mix(prev, op(prev), amount × regionWeight)`.
   - **Spatial passes.** The other ops are separate passes, gated by their region the same way.
   - **New passes:** `viz/post/gradelook.ts` (the colour chain; `grade` was already the editor's simple colour grade), `halation.ts`, `edgeglow.ts`, `depthfog.ts` and `tiltshift.ts`. Each one:
     - calls `registerPost`;
     - has its id in `POST_TYPES` and a catalog entry;
     - is an exact identity at amount 0;
     - is offered in the Video Editor's effects too.
2. **`compileRecipe(recipe, wild, aux)` → `EditPost[]`.** It's pure and golden-tested. The preview, the exports, the pipeline step and the Video Editor's **Looks ▸** all use it.
   - The preview is a one-clip `EditEngine` (a photo or video clip) at the input's aspect.
   - Video previews use the edit-stream preview tier: a prepare job runs when a video is opened, and "Preparing" shows as in the editor.
3. **LUT bake:**
   - A 33³ identity lattice (a 1089 × 33 texture) runs through the `gradelook` pass, using the colour-only ops at the current Wildness with region "all".
   - The pixels are read back, and `GradeService.SaveCube(name, 33, floats)` writes the `.cube` (`TITLE`, `LUT_3D_SIZE 33`, `DOMAIN_MIN`/`MAX`).
   - Ops with any other region are left out and listed.
4. **Flash safety for animated ops:**
   - An animation may swing mean luminance by more than 10% per half-cycle **only** at ≤ 1.5 cycles/s. `compileRecipe` clamps the speed or the swing to keep that true.
   - Beat waves use a 120 ms attack and 300 ms release, never a square wave.
   - A test runs the C4 metric over every built-in look with motion and over 200 Chaos seeds: `flashMaxPerSec` ≤ 3.
5. **Full-resolution stills.**
   - `core/viz.RenderPlan` gets `Still *StillPlan {ProjectJSON, Streams, Images, AtMs, Format "png"|"jpg"|"webp", Quality}`.
   - The host renders one frame with the `EditEngine` on an OffscreenCanvas at `Width × Height`, up to **8192** on the long side, and returns one file, as it does for Composition.
   - That limit is checked against `MAX_TEXTURE_SIZE`. Above it, the job fails with a clear message.
   - The Video Editor's "Still frame (.png)" (§B6) uses the same plan.
6. **Source-size edits.**
   - `EditProject.Size *Size {W, H int}`, added in Wave 0, overrides `Aspect`/`Export.Height` when set.
   - Sizes are even: 64..8192 for stills, ≤ 3840 for video.
   - Only in-memory renders set it: Color Grader and the still plan.

## E4. Backend (`modules/grade/`, module `grade`, `OutputSubdir: "Graded"`)
- **Job `Run`:**
  1. Decode the options: `{recipe, wild, format, beat: {song, on}}`.
  2. Make sure the maps that the recipe's regions use exist (§E5); they're cached.
     - Subject and people mattes come from `modules/editstudio`'s matte runner, exported as `RunMatte`.
     - Depth comes from `depth.*`.
  3. Build the one-clip `EditProject` with `Size` = the source size (≤ 3840 for video). Its `Effects` is a placeholder; the plan carries `Grade {RecipeJSON, Wild}`. The host compiles it with the same `compileRecipe`, so there is **one compiler**.
  4. **Pictures:** a `Still` plan, then write the file. Orientation is applied. Other metadata is copied except orientation, and location only if the input had it.
  5. **Videos:** `editstudio.RenderEdit(ctx, job, name, doc)`, which is today's `renderDoc` exported with `projectID = ""`. The source audio is kept.
  6. `job.Output`.
- **`GradeService`:**
  - `Defaults()`, `Enqueue(inputs, opts)`;
  - `Looks()`, `SaveLook(r)`, `RenameLook`, `DeleteLook`;
  - `Vibe(req {text, seed, n})` → `[]GradeRecipe`: an interactive call on `TextGenerator`, not a job;
  - `Read(path, atMs)` → `[]Suggestion`, through `VisionGenerator`;
  - `Transfer(refPath)` → the `transfer` op's params;
  - `SaveCube(name, size, data)` → the output path;
  - `Masks(path)` → `MaskState {depth, subject, people: {ready, preview, stream}, preparing}`;
  - `PrepareMasks(path, kinds)` → a job;
  - `StepShape()`.
- **Recipe validation** (`recipe.go`, same vectors as TS):
  - unknown kinds are dropped;
  - params are clamped to the schema;
  - ≤ 16 ops, unique ids, names ≤ 40 chars;
  - an LLM reply that doesn't parse is retried once with the error appended, then fails with "The chat model couldn't write a look. Try again or rephrase".
- **Prompts** (`prompt.go`):
  - The system prompt lists the op catalog (kinds, params, ranges, a one-line effect each) and a palette vocabulary.
  - It asks for 3–10 ops a colourist would recognise, and wild combinations are welcome.
  - The reply must be the JSON only: no other text, never people's names.

## E5. Depth and masks
- **Model:** **Depth Anything V2 Small** (Apache-2.0), in the ONNX Community's **fp32** export (99 MB). The Wave 0 spike found fp16 1.5× slower on the CPU for a 0.004 mean difference.
  - It's pinned `{file, url, sha256}` in `modules/grade/models.go`, measured in a Wave 0 spike.
  - It lives in `<models>/depth/` as pack component `depth-v2s` in a new **Color** pack (`color`) that holds only this model.
  - Color Grader works without it; near/far regions say "Install Color".
  - Handlers never download. `FetchModel` calls `depth.prefetch`.
- **Engine handlers** (`sidecar/toolbox_sidecar/handlers/depth.py`):
  - **`depth.image {path, model, out}`:**
    - inference at 518 px on the short side, keeping the aspect, each side rounded to a multiple of 14 (about 0.8 s per photo on this PC);
    - upsampled to ≤ 2048 on the long side, with guided-filter edges against the picture;
    - writes a 16-bit PNG: near = white, `log1p` and then normalised p2..p98, so one very near object doesn't crush the background.
  - **`depth.video {path, model, outDir, fps}`:**
    - **Sampling:** inference at 266 px on the short side (about 0.3 s per frame). Above 15 fps only every 2nd frame is inferred, and the frames between are interpolated. A 30 s clip at 30 fps takes about 2–3 min.
    - **Smoothing:** a temporal EMA with α 0.6, reset on scene cuts (mean |Δ| of a 64 px thumbnail > 0.25).
    - **Normalisation:** per clip, p2..p98.
    - **Output:** two grey edit streams (preview and export tier: Annex-B H.264 + `.idx.json`, the same format as mattes), written by piping raw frames to FFmpeg.
  - Both report progress and call `check_cancelled` between batches of 8 frames.
- **Cache:** `cache/grade/<fileKey>/` (`depth.png` or the depth streams, `subject.png`, `people-*`), pruned at start after 30 days or above 5 GB.
- **Engine aux maps** (a Wave 0 contract: `ClipAux`):
  - `EditFiles` keys: `d:<id>` is a depth stream, `a:<path>` a still map PNG.
  - The clip renderer binds `u_depth` and `u_subject` (0..1) for passes that declare `needs: ["depth" | "subject" | "people"]`.
  - A missing map is a constant (depth 0.5, subject 1), and the tool shows that region as unavailable.

## E6. Errors and limits
- **Size caps:** a picture over 8192 px on the long side exports at 8192, with a notice saying why. A video over 3840 exports at 3840.
- **A region's model is missing:**
  - the op is greyed out with an install button;
  - the job refuses with `CodeDependencyMissing`, naming the pack.
- **No chat model:** Vibe and Read the picture show the `DepsGate`. Everything else works.
- **Depth for video is slow on the CPU.** Wave 0 measures seconds per frame. Regions shows an estimate before it starts ("about 4 min for this 30 s clip").

## E7. Tests
- **TS:**
  - every op's reference function on vectors;
  - `compileRecipe` goldens for all 40 looks at Wildness 0, 0.5 and 1;
  - Chaos determinism, and the lock;
  - recipe validation on the shared vectors;
  - LUT lattice mapping;
  - flash safety over 200 seeds;
  - every look's ops are in the catalog, and the catalog matches `POST_TYPES`.
- **CPU-backend reference:** the `gradelook` pass with Neon Noir's colour ops on a 64 × 64 fixture equals the reference functions within 2/255.
- **Go:**
  - recipe validation and clamps;
  - prompt and parse with a fake `TextGenerator`: valid, invalid then retry, garbage;
  - transfer stats on synthetic images;
  - the `.cube` writer;
  - the job against a fake broker and `Caller`;
  - the `Chainable`, including a vibe template;
  - mask cache keys and prune.
- **Python:**
  - `depth.image`/`depth.video` with a tiny fixture model built in the test: shapes, normalisation, EMA and the scene-cut reset;
  - the real model under `TOOLBOX_SLOW=1`.
- **Architecture:** `src/grade/` is engine-level (like `composer/`), and it imports no tool.

## E8. Acceptance (real build, the demo media)
1. **Rainy-street photo (HEIC, 4032 × 3024):**
   - Wildness 0 → 1 on Neon Noir: the subject regions come from the Background Remover model, and the edge glow appears only above 0.66.
   - The export is a full-resolution, upright JPEG that matches the preview (mean diff of a 1080 render < 2/255).
2. **Skyline:** Depth Rainbow and Inferno by Depth separate near from far, and Regions shows the depth thumbnail.
3. **Vibe:**
   - 10 prompts each give a valid, visibly different look within 8 s. They include "haunted vaporwave mall at 3 am", "wes anderson but cursed" and "toxic swamp rave".
   - More like this gives 3 variations.
4. **Read the picture** on the ferris wheel gives 6 named suggestions whose reasons mention what's in it.
5. **Steal a look:** the dessert photo's colours land on the skyline.
6. **Chaos:**
   - seed `#4821` gives the same look after a restart;
   - a locked op survives 5 rerolls.
7. **Video:** `Snoop Dog Dancing` with Acid Bath, animated and beat-synced to `song.short`:
   - the export plays, matches the preview and keeps its audio;
   - the motion metric gives ≤ 3 flashes per second.
8. **`.cube`:** FFmpeg `lut3d` on a picture matches the colour-only render within a mean ΔE of 2.
9. **A saved look** appears in the Video Editor under Looks ▸ and gives the same picture on a clip.
10. **Pipeline:** folder → "Grade with a look" (vibe `{name} as a fever dream`) → Image Batch.
11. **Standalone:** all 5 points hold with no other tool open.
12. **Screens:** 1180 × 720 and 960 × 600, light and dark.

---

## F. Decisions
- **Personal stays in place.** No migration, so there's zero risk to your data. Other workspaces are `<root>/{Library, .toolbox}`.
- **One tools folder for all workspaces.** Models are ~4–7 GB, so per-workspace copies would waste space. Capture uses the sandbox's tools (`.dev/support`), so filming never installs into your Personal tools. **When you demo live from your Personal app, Demo uses your tools folder.** Install any packs it lacks once from Settings → Packs.
- **Switching relaunches** rather than hot-swapping. Every service holds DB handles and paths, so a relaunch is the only clean switch.
- **Demo workspace location:** `<repo>/workspaces/demo` (git-ignored, next to `demoAssets`). Change it here if you'd rather keep it outside the repo.
- **Capture through the DevTools screencast**, not desktop capture. It records only Toolbox and never your screen. The managed FFmpeg 8.0 has no window-capture source that works with GPU WebViews. The cost is 30 fps UI footage; renders are 60 fps.
- **The wheel zooms only with Ctrl** in both editors, as in other editors. This changes today's behaviour.
- **Overwrite on overlap** replaces today's "refuse the move".
- **The Visualizer analysis is unchanged** (no re-analysis). All smoothing, ramps and rate limits are TS-side.
- **Intensity** keeps its field (`reactivity`); Balanced = 1 after the retune. Saved designs keep their value, so they get the calmer engine automatically.
- **Demo media privacy.**
  - The selfie, the home floor plan and the personal sketch-blog text are excluded from the Demo workspace (`exclude`).
  - Every photo copy has its location stripped (your iPhone photos all carry GPS).
  - The Redact scene uses strangers in the rainy-street and ferris-wheel photos, never you.
- **Missing media is generated with Toolbox itself:** a TTS narration, a Ken Burns B-roll reel, a noisy copy, and a PDF of a short article I write. Nothing is downloaded from stock sites.
- **Color Grader renders on the editor's engine.** The preview equals the export, and it reuses mattes, streams and the RenderBroker. Its looks are effect stacks the Video Editor can use too.
- **The depth model is Depth Anything V2 *Small*** (Apache-2.0); the larger versions are non-commercial. There is no text-to-image or artwork-trained model. The "AI" is the local chat/vision model writing recipes, plus segmentation and depth maps.
- **One real workspace runs at a time** (one app lock), so files opened from Explorer always reach the open window. Start at login always opens Personal.

---

## G. Work packages

### Wave 0 — foundation (architect, sequential, on main)
1. CLAUDE.md "Workspaces, editor parity, calm visuals, Color Grader and the demo (Phase 21)" section; DECISIONS; ROADMAP row; `.gitignore` gets `demoAssets/`, `workspaces/`.
   - **Spikes** (results in DECISIONS):
     - Depth Anything V2 Small ONNX pins, and its CPU speed on a picture and on 1080p video (seconds per frame);
     - WebView2's `MAX_TEXTURE_SIZE` on this PC.

     The motion metric's "before" run belongs to V2.
2. `core/workspace` types, `Resolve` signature, `Presenter` and `WorkspacesService` stubs. The `workspace` hidden module skeleton. `main.go` boot through `Resolve`, still behaving as today. `dryrun.go` signature.
3. **Go contracts:**
   - Document v2: the new fields, `ExportSettings`, `Size`, the clip's `Depth` aux ref, and the v1 → v2 reader.
   - `SourceState.Audio`/`Peaks`; `RenderPlan.Still` and `Grade`.
   - Validation limits.

   **Part E skeleton:**
   - `modules/grade`: Descriptor, Options, `Chainable` stubs, `GradeService` stub, and the `recipe.go` types with the shared vectors.
   - The `color` pack with its `depth-v2s` component, and a `handlers/depth.py` stub.
   - `frontend/src/grade/types.ts` and the shape of the `ops.ts` catalog.
   - `POST_TYPES` ids `gradelook`, `halation`, `edgeglow`, `depthfog`, `tiltshift`, as stubs.
   - The `ClipAux` contract.
   - A stub `GradeView`, `StepUI` and `paramDefs`; the icon `palette`; keywords.

   **Isolation fixes (§A6b) in shared files:**
   - the `modules/posts` library fallback;
   - the `core/jobs.go` tmp fallback;
   - `deps-cache.json` moves to the tools dir;
   - the subprocess `TMP` env;
   - the root `workspace_isolation_test.go` scan.
4. Frontend contracts:
   - `editor/audio/types.ts` (`PlaybackClock`, `Mixer`, `PeaksSource`, `usePeaks`);
   - `Key.ease`/`bez` in `viz/edit/types.ts`;
   - `Transform.crop` in the schema;
   - `POST_TYPES` ids `chromakey`, `lumakey` with stub registrations and catalog entries;
   - `FrameCtx.integral/beatIntegral` signatures (they throw until V1 lands);
   - `SIGNAL_CLASS_DEFAULTS`;
   - `EDIT_SHORTCUTS` entries for every new key (handlers no-op);
   - the `motion.json` type;
   - a stub for handling `StillPlan` in `RenderHost`.
5. Regenerate bindings; re-export from `lib/api.ts`. All checks green.

### Wave 1 — parallel builders

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **W1 Workspaces backend** | §A2–A4, A6, A6b (tools lock, missing/corrupt handling, overlap checks, one app lock + arg hand-off) Go: resolve, registry, boot wiring, instance/webview/devtools/dry run/no-hotkeys, relaunch `--workspace`, tray submenu, seed/restore/tidy jobs, library lock, LAN alias default, Presenter, window title | `core/workspace/**`, `modules/workspace/**`, `api/workspaces.go`, `core/focus/dryrun.go`, `desktop/relaunch*.go`, `desktop/tray*.go` (workspace submenu), `desktop/hotkeys.go` (env), the boot lines in `main.go`, `core/settings.go` (library lock), `core/lan/runtime.go` (alias) | Wave 0 |
| **W2 Workspaces UI** | §A1, A5 frontend: chip and menu, palette, Settings → Workspaces, New/Add dialogs, Tidy preview, `displayPath` adoption, errors rewrite | `frontend/src/views/SettingsWorkspaces*`, `frontend/src/state/workspace.ts`, `frontend/src/lib/displayPath.ts`, the chip in `shell/Sidebar.tsx`, `shell/useBuiltinCommands.ts` lines, `displayPath` call sites in `tools/_kit/**`, `views/library/**`, `views/Settings*.tsx`, `components/DepsGate*`, `shell/JobRow.tsx`, `shell/LogPanel.tsx`, `lib/errors.ts` | Wave 0 |
| **E1 Editor backend** | §B0 validation, B1 prepare (`audio.m4a`, peaks), B1 export mix, B6 render settings (codec/quality/fps/range/audio-only/still) | `modules/editstudio/{sources,audio,render*,validate,service}.go` (+ tests) | Wave 0 |
| **E2 Playback & audio** | §B1 frontend: clock, mixer, `wholeFile`, decoding LRU, scrub audio, song through the mixer; transport (timecode readout, quality toggle, J/K/L on the clock); §B6 dialog | `frontend/src/editor/audio/**`, `frontend/src/editor/transport/Transport.tsx`, `transport/logic.ts`, `frontend/src/lib/wholeFile.ts`, `frontend/src/editor/export/**`, playhead fields in `editor/store.ts` | Wave 0 |
| **E3 Timeline** | §B2, B7: ruler, markers, ranges, zoom, track headers and heights, audio tracks, waveforms, tools V/C/B/N/Y, ripple, close gap, clipboard, overwrite/insert, links, detach, keyframe strip, volume line, snapping toggle, shortcut handlers | `frontend/src/editor/timeline/**`, `editor/transport/{shortcuts,commands}.ts`, `editor/geometry.ts`, the timeline toolbar | Wave 0 (E2's `usePeaks`/clock via contracts) |
| **E4 Keys, crop, PiP, easing** | §B3, B4: `chromakey`, `lumakey`, Green screen stack, eyedropper (`samplePre`), crop (renderer + handles), PiP presets, ease picker and bezier editor | `frontend/src/viz/post/{chromakey,lumakey}.ts`, `viz/edit/{clip,params}.ts`, `editor/inspector/**`, `editor/overlays/**` | Wave 0 |
| **E5 Seeking** | §B5: paused read-ahead, back-step cache, reverse play, edit-point jumps (handlers via E3's command table), `setEdit` identity, Draft/Full, "Preparing" bar, last good frame | `frontend/src/viz/frames/**`, `frontend/src/viz/edit/EditCanvas.tsx`, `viz/edit/engine.ts` (`samplePre` + quality) | Wave 0 |
| **V1 Calm engine** | §C2: integrals, layer rewrites, envelope classes, energy ramp, master intensity through drive/posts/events/transitions/palette, director hold/rate/morph/feedback, palette hysteresis, post changes; continuity tests | `frontend/src/viz/{signals,engine,director,palette,transitions,transitionsMath}.ts`, `viz/layers/**`, `viz/post/{shake,zoompulse,chromatic,glitch,px1math}.ts`, `viz/text/index.ts` (raw read) | Wave 0 |
| **V2 Motion metric** | §C4 + the "before" run on Wave 0 main | `frontend/src/viz/lab/**`, `TOOLBOX_VIZLAB_MODE` in `main.go`'s VizLab URL lines | Wave 0 |
| **G1 Grade engine** | §E3: op catalog + reference math, the `gradelook` colour pass and the new spatial passes, `compileRecipe`, the 40 looks, Chaos, LUT bake, the flash-safety clamp, aux binding (`viz/edit/clipAux.ts` `bindAux()`, which E4's clip renderer calls; `aux` is a reserved file name on Windows), the `Still` path in `RenderHost` | `frontend/src/grade/**`, `frontend/src/viz/post/{gradelook,halation,edgeglow,depthfog,tiltshift}.ts`, `frontend/src/viz/edit/clipAux.ts`, the still lines in `viz/RenderHost.tsx` | Wave 0 |
| **G2 Grade backend** | §E4–E5: job, service, recipe validation, prompts (Vibe, Read), transfer, `.cube`, looks file, mask cache + prune, `Chainable`; `depth.*` handlers + tests; `RunMatte`/`RenderEdit` exports in editstudio | `modules/grade/**`, `sidecar/toolbox_sidecar/handlers/depth.py`, `sidecar/tests/test_depth.py`, `modules/editstudio/exports.go` | Wave 0 |
| **G3 Grade UI** | §E1: the workspace tool, gallery, Wildness, rail panels, regions view, export, results, the step UI | `frontend/src/tools/grade/**`, `frontend/src/pipelines/steps/grade.tsx`, its `paramDefs` lines | Wave 0 |
| **D1 Capture harness** | §D1 harness, `make-assets.mjs` (§0), a smoke scene (00 Tour) filmed on the sandbox, README | `demo/**` (except scenes 01–46) | Wave 0 |

### Wave 2 — after Wave 1 merges
- **V3 Preset retune** (builder): §C1, C3 on every preset, grammar lint, Intensity stops in `components/viz/VisualsPicker.tsx` and `blocks/visuals/designer/LookTab.tsx`. It iterates against `motion.json` until §C6 passes. Owns `viz/presets/**` and those two files.
- **I1 Integration** (architect):
  - merge;
  - bindings;
  - Edit Studio regression;
  - the Video Editor's **Looks ▸** menu (saved Color Grader looks);
  - Part E acceptance with the real models;
  - the isolation fs-diff (§A acceptance 9);
  - B10 measurements;
  - A and B acceptance;
  - QA shots (`.dev/p21-qa/`);
  - the CLAUDE.md final pass.

### Wave 3 — the demo (after Wave 2; `demoAssets/` is in place)
1. **Architect:** `demo/roles.json` (from §0), the generated assets, the production binary, the seeded capture workspace.
2. **D2a / D2b / D2c** (builders, in parallel) write scenes 01–15, 16–30 and 31–46 plus B-roll. Each verifies its scenes on its own capture workspace (`.dev/workspaces/capture-<pkg>`) and its own DevTools port (9231 / 9232 / 9233), one scene at a time.
3. **Architect:**
   - the final full filming run, done sequentially;
   - the review (§D4.3) and re-shoots;
   - before/after Visualizer renders;
   - create `workspaces/demo` from `demoAssets`, copy the footage in, build the rough cut;
   - the OCR privacy grep;
   - the summary.

### Later
- Two workspaces open side by side (separate hotkeys, tray and LAN port).
- Export or import a workspace as a zip.
- Editor: nested sequences, colour wheels, audio effects (EQ, compressor), motion tracking.
- Capture with app audio (WASAPI loopback per process) and pop-out windows.
