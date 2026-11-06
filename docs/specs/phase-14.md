# Toolbox — Phase 14 (DRAFT): Every tool composes, and the app gets easier to use

Status: **BUILT 2026-11-04, uncommitted for review** (approved with "approved"). This draft comes from the usability and composability audit of 2026-11-04. Not approved, not built.

## 0. The audit

### 0.1 Composability: where the model holds and where it breaks

The pipeline catalog was read from the running app, and the tool views were checked with grep.

| Capability | Status |
|---|---|
| Open a tool with files (handoff) | Every tool. |
| Open a tool inside another tool (`ToolClickIn`) and pop it out | Every tool. |
| **Pipeline step** | Available: 21 tools run automatically, plus 6 built-ins (Check, Rename, Ask Local Chat, Table, Zip, Copy). Object Eraser is **manual only**. **Missing entirely: Photo Composer, Post Builder, Video Editor, Edit Studio, Dev Utilities, Clipboard History.** Local Chat appears only as the "Ask Local Chat" built-in, not as itself. |
| Send to on results | Every file tool. **Missing:** workspace exports (Photo Composer, Post Builder, Video Editor, Edit Studio), Dev Utilities file results. Vault entries and chat attachments are left out by design. |
| Send to a **pipeline** | Library rows only. **Result rows can't.** |
| Drag a result anywhere inside the app | **Nothing is draggable.** Result rows, Library rows and image cards can't be dragged. Sidebar tools aren't drop targets: a file dropped on "Converter" goes to the open view. |
| Pipelines inside pipelines | **No.** A saved pipeline can't be a step of another. |
| Triggers | Manual or watch folder only. There is no "when I copy a link" or "when I send files here". |

### 0.2 Usability: top issues, by impact

These come from all 62 screenshots plus the shell, kit, Library, palette, paste and drop code.

1. **The sidebar is a flat list of 29 tools.** At 720 px, ten of them are below the fold. In the icon rail, Stem Splitter, Edit Studio and Audio Cleanup share near-identical waveform icons. `Descriptor.Category` exists but the sidebar ignores it.
2. **Failed jobs vanish from the tool page.** The tray's red "19 failed" never clears.
3. **Disabled buttons can't show why.** `pointer-events: none` hides their tooltips, and a disabled primary button looks brown rather than disabled.
4. **Results can't be dragged** (0.1).
5. **The palette searches tool names only.** "vocals", "metadata", "noise", "merge", "mp3" and "youtube" find nothing. "EXIF" and "OCR" are jargon names.
6. **Paste is narrow.**
   - Any pasted link goes to the Downloader, even on Web Archiver.
   - Pasting copied files or a screenshot does nothing.
7. **The Library is weak.**
   - Its sidebar entry is "Recent", under a "Library" heading that also holds Pipelines.
   - Send to uses the same icon as Open.
   - Trash forgets an entry with no undo.
   - There are no type chips and no multi-select.
8. **Result rows differ between tools.**
   - Hover-only actions in some tools, always-visible in others.
   - The folder button is "Reveal folder", "Open folder" or "Downloads folder".
   - Headings vary: "Results", "Recent conversions", "Recent pages".
   - Sizes are KiB in some places and MB in others.
   - Dates are "Oct 27" in some places and "47m ago" in others.
9. **Completion toasts don't help.**
   - They fire even when you're looking at the results.
   - One toast per file floods on a batch.
   - Reveal is the only action.
10. **First-run install prompts are confusing.**
    - Local Chat shows two install buttons of the same size.
    - It then asks for a second model decision.
    - "New chat" is enabled with nothing installed.
    - The FFmpeg fallback shows a terminal command, though the app manages FFmpeg.
11. **Keyboard gaps.**
    - No Add files shortcut.
    - Mod+1…9 targets aren't shown anywhere.
    - There's no shortcuts overlay.
12. **Secondary text is too faint.** `--fg-subtle` is about 3.5:1 contrast, and it's used on sizes, dates and summaries in about 129 places.
13. **Narrow headers lose meaning.**
    - Primary actions collapse to bare icons (Export, Auto-fill).
    - Lyric Video says "Render" where the other tools say "Export".
    - Dev Utilities shows two pop-out icons.
14. **Undo is split or missing.**
    - Lyric Video has two undo stacks.
    - Removals from lists (Library Forget, Clear, job Remove) can't be undone.
15. **Unclear labels.**
    - Back arrows are icon-only.
    - Edit Studio's "Music | Video" switch reads like switching tools.
    - EXIF has three competing actions.
    - "Remove background images" is awkward.

**Quick wins:**
- Library's Send to icon becomes `send`.
- Label the PDF Toolkit's OCR rail item.
- Remove the Visualizer's second fullscreen icon.
- Audio → MIDI's button becomes "Make MIDI".
- Stem results: add the time to the headings of repeated runs.
- Pipelines fits the graph on open.
- Truncated track names get a tooltip.
- Settings: "Install the rest (43 MB)" instead of "Partly installed + Install"; shortcut labels shouldn't wrap.

## 1. Goals

### A. Every tool is a pipeline step, and a test proves it
`TestEveryToolIsAPipelineStep` registers every module the way `main.go` does. It asserts that every user-facing tool is in the pipeline catalog with an automatic step and a step editor (`pipelines/steps`). **There is no exemption list.** The frontend mirrors it: every tool id has a `StepUI`, and the palette lists it.

New steps:
- **Photo Composer — "Fill a template".** A saved composition marks one or more photo layers as slots. Each input, or each group of N, fills the slots and is rendered. Compositions render in the webview (`composer/render.ts`), so the step renders through the main window's `RenderHost` and the existing `RenderBroker` raw-message path, as Visualizer exports do. If no window is open, the step waits ("Open Toolbox to render"), in the same way as the existing `ErrWaiting`.
- **Video Editor — "Assemble a video".** Clips in order, with optional transitions, a title, a music bed and an aspect ratio, laid into a new edit, or into a saved edit used as a template. Rendered with the edit engine export (`viz/edit/worker.ts`).
- **Edit Studio — "Cut to the beat".** A song plus clips. An auto-fill recipe (`autofill/recipes.ts`) builds the edit, then the edit is rendered. This is the showcase step.
- **Post Builder — "Make a post".** Files become a carousel or reel post. Exports the post folder with `RenderProject` / `SaveRender` as today.
- **Dev Utilities — "Checksums".** Writes SHA-256/SHA-1/MD5 for each file to a `.sha256` file or a CSV. "Encode" covers Base64 and hex for small files.
- **Clipboard History:**
  - A **trigger** "When I copy…": a link, an image or text matching a pattern. It works only while recording is on, follows the existing privacy rules, and never fires on sensitive copies.
  - A **step** "Copy to clipboard": puts a text result on the clipboard.
- **Local Chat.** "Ask Local Chat" becomes `llm-chat`'s own step, so the palette names it after the tool. The old built-in id stays as an alias.
- **Object Eraser — automatic mode.** It reuses a mask saved in the tool for same-sized images (photo series from a tripod), or erases with SAM 2 from a point the user saved. Manual stays the default.
- **"Run another pipeline".** A built-in step that runs a saved pipeline as a sub-run with its inputs. Cycles are refused at save time.

### B. Drag and drop everywhere
- **Drag sources.** Every file row is draggable: kit result rows, image cards, Library rows, Downloader/Archiver recents, workspace export results, pipeline run files. The drag uses a custom type carrying the paths (`application/x-toolbox-paths`), plus `text/uri-list`.
- **Drop targets:**
  - each sidebar tool, which opens that tool with the files;
  - pipeline cards and graph Input nodes;
  - editor media bins;
  - Post Builder slides;
  - Photo Composer's canvas (as layers);
  - every DropZone.

  The visual is the existing DropOverlay ring. Pipeline graph nodes also accept a dragged tool from the sidebar, which adds that step.
- **Dragging out to Finder or Explorer** needs a native hook from Wails. It's a follow-up, logged and not blocking.

### C. Results flow everywhere
- One shared `ResultRow`:
  - double-click or Enter opens the file;
  - **Send to** is always visible, with tools, "in a new window" and **Pipeline: <name>** entries;
  - Reveal and Open appear on hover;
  - one heading ("Results"), one size format (KiB/MiB everywhere) and one date format (relative under a day, then a date).
- Workspace exports (Photo Composer, Post Builder, Video Editor, Edit Studio, Visualizer, Lyric Video, Subtitles) end in a result row with Send to, not just a toast.

### D. Usability fixes
These are the audit's items 1–3 and 5–15, in summary:
- **Sidebar:** grouped by category with collapsible labels; pinned favourites and recently used; rail separators; distinct icons.
- **Failed jobs:** this session's failed and cancelled jobs stay on the tool page as `JobRow`s with Retry until dismissed. The tray counts failures since it was last opened.
- **Disabled buttons:** use `aria-disabled`, so the tooltip works and the button stays focusable, with a neutral disabled primary. A "needs" line shows under primary buttons.
- **Palette:** matches taglines and new `Descriptor.Keywords`, and shows the tagline in results. Renames: "Photo Metadata", "Text from Images".
- **Paste:**
  - a link goes to the current view if it takes links, otherwise to the Downloader, with Undo;
  - pasted files and images are read on the Go side and handed to the current tool like a drop.
- **Library:**
  - its entry is called "Library", and Pipelines gets its own section;
  - type chips;
  - multi-select with bulk Send to, Pipeline and Forget;
  - Forget can be undone.
- **Toasts:** none when the tool is on screen; batches merge into one toast with Send to and Reveal.
- **DepsGate:**
  - one button when the pack equals what the tool needs;
  - the install includes the default chat model;
  - New chat is disabled until something is installed;
  - FFmpeg gets a real install button.
- **Keyboard:**
  - Mod+O adds files everywhere.
  - Mod+1…9 open pinned tools, and the digits are shown in the sidebar.
  - `?` opens a shortcuts overlay.
- **Contrast:** `--fg-subtle` reaches about 5:1 in both themes.
- **Headers:**
  - Primary actions never lose their label.
  - "Export" is used everywhere.
  - One pop-out icon.
  - The composition menu is labelled.
- **Undo:**
  - one history per document (Lyric Video);
  - Undo toasts for removals from lists.
- **Labels:**
  - "‹ Projects" instead of a bare back arrow;
  - "Song view / Clip view" in Edit Studio;
  - EXIF as one choice plus Run;
  - "Remove backgrounds".
- All the quick wins in 0.2.

## 2. Non-goals
- Native drag-out to the OS, beyond logging the follow-up.
- New tools.
- LAN sharing (Phase 13 still needs its listener-rule amendment).

## 3. Work packages

Shared contract (architect): `frontend/src/lib/fileDrag.ts` (`PATHS_MIME`, `TOOL_MIME`, `startPathsDrag`, `startToolDrag`, `readPaths`, `readTool`, `hasPaths`, `hasTool`). Any in-app drop on a `[data-file-drop-target]` element routes like an OS file drop on it.

| Wave | WP | Scope | Owns |
|---|---|---|---|
| 1 | A1 | Go steps: Dev Utilities (Checksums, Encode), Post Builder (Make a post), Local Chat (its own step, old built-in id as alias), Clipboard (trigger + Copy to clipboard step), Object Eraser automatic mode (saved mask) + its service methods, "Run another pipeline" built-in, `TestEveryToolIsAPipelineStep` | `modules/{devutils,posts,clipboard,chat,eraser}/**`, `core/pipeline/**`, `core/pipeline_types.go`, `modules/pipelines/**`, root `*_test.go`, `integration/**` |
| 1 | A2 | Headless render path for steps through the main window's `RenderHost` (compositions, edits); Photo Composer "Fill a template", Video Editor "Assemble a video", Edit Studio "Cut to the beat" (Go Chainable + the webview render side) | `modules/{composer,videoeditor,editstudio}/**`, `core/viz/**`, `frontend/src/viz/RenderHost.tsx`, `frontend/src/viz/edit/**`, `frontend/src/composer/**` |
| 1 | B | In-app drop routing (global dragover/drop → `[data-file-drop-target]` → the OS-drop route), DropOverlay for in-app drags, `DropZone`, Pipelines: cards/Input node take files, the graph takes dragged tools, fit-on-open | `lib/fileDrag.ts`, `shell/dropRouting.ts`, `shell/DropOverlay.*`, `components/DropZone.*`, `tools/pipelines/**` |
| 1 | C | Shared `ResultRow` (draggable, double-click/Enter opens, Send to always visible incl. **Pipeline: …**, Reveal/Open on hover, one heading/size/date format), failed jobs stay on kit pages, `DepsGate` (one button, chat model, FFmpeg install), every file tool's result list and labels (EXIF one choice + Run, "Make MIDI", "Remove backgrounds", stem run times, PDF OCR rail label) | `tools/_kit/**`, `tools/{downloader,archiver,pdf,stems,devutils,trimmer,redact,eraser,audiocleanup,converter,bpmkey,exif,bgremove,upscale,documents,transcribe,ocr,midi,chat,vault,clipboard}/**` |
| 1 | W | Workspace tools: export results as draggable rows with Send to, drops (editor media bin, Post Builder slides, Photo Composer canvas), Lyric Video single undo, "Export" naming, labels ("‹ Projects", "Song view / Clip view"), Visualizer's duplicate fullscreen, track-name tooltips | `tools/{photo-composer,post-builder,subtitles,lyricvideo,visualizer,edit-studio,video-studio,video-editor}/**`, `editor/**`, `blocks/**` |
| 1 | D1 | Shell: sidebar grouped by category + pins + recents + digits, sidebar tools as drop targets and tool drag sources, palette keywords (frontend map) + taglines, paste routing (links to the current tool, files/images via a new `FilesService` method), Mod+O, shortcuts overlay, toast batching, tray failures since last seen | `shell/**` (except dropRouting, DropOverlay), `api/files.go`, `state/ui.ts` |
| 1 | D2 | Components and tokens: `aria-disabled` buttons with tooltips and a neutral disabled primary, `--fg-subtle` contrast, primary actions never collapse, labelled composition menu; Library rework (name, type chips, multi-select bulk Send to / Pipeline / Forget, undoable Forget, draggable rows); Settings quick wins | `components/**` (except DropZone), `styles/**`, `views/**` |
| 2 | A3 | Step editors for every new step, the frontend proof test (every tool has a StepUI and is in the palette), Object Eraser "save mask for pipelines" UI | `pipelines/steps/**`, `tools/eraser/**` (that UI only), `tools/pipelines/**` (palette only) |

Acceptance:
- Both proof tests pass with no exemptions.
- A pipeline built only by dragging can use every tool.
- The audit's 15 items and quick wins are done, each checked at 1180×720 and 960×600.
