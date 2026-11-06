# Toolbox — Phase 12 Spec: Documents

Status: **BUILT 2026-11-04, uncommitted for review** (approved when the user said "ok keep going" after the draft was presented; the open questions took the recommended answers, §11). Phase 11 is archived in `docs/specs/phase-11.md`.
Tool facts were checked against the official GitHub releases on 2026-11-04. sha256 values are GitHub's per-asset digests, because none of these projects publishes a checksum file. Re-hash them once after the first download.

## 0. The brief

ROADMAP Phase 12: "Documents: Pandoc conversion (+ Typst for PDF), maybe Calibre ebook conversion; the Web Archiver placeholder." Both tools follow the Phase 10/11 rules from day one:
- a minimal surface;
- constituents in click-ins;
- Send to and Use on every result;
- pipeline steps;
- no tool importing another.

## 1. Goals
1. **Document Converter** (`documents`): convert between docx, odt, rtf, epub, html, Markdown (CommonMark/GFM), LaTeX, Typst, ipynb and pptx (output only), plain text, and **PDF via Typst**, with no TeX install.
   - Batch input.
   - One primary setting ("Convert to").
   - Advanced: page size and margins, main font, table of contents, section numbering, a reference docx/odt for styles, standalone HTML with embedded resources, extract media.
2. **Web Archiver** (replaces the `archiver` placeholder): save a URL as one self-contained `.html` file (monolith).
   - Optional "Render JavaScript first", using an installed Edge/Chrome headless with a temp profile and **no debugging port**.
   - Optional PDF of the page, through the same browser's `--print-to-pdf`.
3. **Compositions:**
   - Document Converter → PDF Toolkit ("Make searchable", "Compress") on PDF results.
   - Web Archiver → Document Converter ("Convert…") on archived pages.
   - OCR → Document Converter ("Save as docx/Markdown") on recognised text.
   - Every result has Send to.
4. **Pipeline steps** for both (`core.Chainable`). The built-in template "Paper to archive" (ROADMAP) gains an optional "Save as docx" branch.

## 2. Non-goals
- Calibre / MOBI / AZW3. Calibre is a 358 MB dmg or a 218 MB installer with no extractable archive, and Pandoc reads and writes EPUB already. It can be an opt-in pack later (DECISIONS).
- Editing documents.
- WYSIWYG preview beyond a first-page thumbnail and the HTML/Markdown text preview.
- SingleFile CLI: it always opens an unauthenticated `--remote-debugging-port`, which breaks the no-listener rule.
- PDF → docx "reflow" beyond what Pandoc does (Pandoc can't read PDF; say so in the UI and offer OCR → text).

## 3. Dependencies (`core/deps`, pinned managed archives)

| Dep | Version | Asset (macOS arm64 / Windows x64) | Size | sha256 | License |
|---|---|---|---|---|---|
| `pandoc` | 3.13 | `pandoc-3.13-arm64-macOS.zip` / `pandoc-3.13-windows-x86_64.zip` | 43.1 / 43.0 MB | `f436d18b…a7c3` / `23e1f2e9…6a4e` | GPL-2.0+ (separate process) |
| `typst` | 0.15.1 | `typst-aarch64-apple-darwin.tar.xz` / `typst-x86_64-pc-windows-msvc.zip` | 14.4 / 22.5 MB | `48f62ed0…c05a` / `19ce3551…6736` | Apache-2.0 |
| `monolith` | 2.12.0 | `monolith-cli-macos-aarch64-apple-darwin` / `monolith-cli.exe` (raw binaries) | 6.2 / 5.5 MB | `2dc89a79…48a9` / `ed21a106…3eed` | CC0-1.0 |

Full digests (copy exactly into `core/deps/{pandoc,typst,monolith}.go`; exact byte sizes come from the GitHub release API, `https://api.github.com/repos/<repo>/releases/tags/<tag>`; D0 downloads the Windows assets once into `.dev/p12/` to confirm size and digest):
- `jgm/pandoc` tag `3.13`: `pandoc-3.13-arm64-macOS.zip` `f436d18bebbfb3ddd326597686dacab9fac5dc23bd060495020f35a28a43a7c3`; `pandoc-3.13-windows-x86_64.zip` `23e1f2e978a3df80db8bf65c9c59534f41a23140480cfb4f783a882ab7dc6a4e`. Zip roots: `pandoc-3.13-arm64/bin/pandoc` (macOS), `pandoc-3.13/pandoc.exe` (Windows).
- `typst/typst` tag `v0.15.1`: `typst-aarch64-apple-darwin.tar.xz` `48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a`; `typst-x86_64-pc-windows-msvc.zip` `19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736`. Roots: `typst-<target>/typst[.exe]`. (If the archive code has no `.tar.xz` support, add it with a pure-Go xz reader, e.g. `github.com/ulikunitz/xz`, noted in DECISIONS.)
- `Y2Z/monolith` tag `v2.12.0`: `monolith-cli-macos-aarch64-apple-darwin` `2dc89a796d9c6932e7c7c7a6d58011ec7d99b9c6f454619283664e2aeb0148a9`; `monolith-cli.exe` `ed21a1062e3c07f4bed05e4bfccaa872aa2a36ac07aa0eb0de807ea956953eed`.

- **ArchiveSpec support:**
  - Pandoc and Typst are normal `ArchiveSpec`s (the Deno pattern). Pandoc's macOS zip contains **symlinks** (`pandoc-server`, `pandoc-lua`): the extractor skips symlinks and the layout keeps only `bin/pandoc`.
  - Monolith ships raw binaries, so `ArchiveSpec` gains a `Raw bool` part mode (download → verify → chmod → move; no extraction).
- `AllowSystem: true` for pandoc and typst; a system copy counts, managed wins.
  - **Typst's version is checked: below 0.12, Pandoc's templates fail.** Use the managed copy then, or report `CodeDependencyMissing` with a hint.
- **Pack:** a new **Documents** pack containing pandoc, typst and monolith (~64 MB download). Every new module belongs to it.

## 4. Running the tools safely
- **Pandoc:**
  - always runs with **cwd = the job's TempDir**: Pandoc writes Typst's temp `.typ` file and media into the cwd;
  - always gets `--data-dir=<support>/pandoc` (empty), so it never reads `~/.local/share/pandoc` or `%APPDATA%\pandoc`;
  - always gets `--resource-path=<input dir>` (OS list separator);
  - always gets `+RTS -M1024M -RTS`;
  - always gets `--pdf-engine=<managed typst path>` for PDF.
  - Never `pandoc server`; never user Lua filters.
- **Typst** (through Pandoc's env):
  - `TYPST_PACKAGE_CACHE_PATH=<tools>/typst/packages`;
  - `TYPST_FONT_PATHS=<media.Fonts() dirs>`, so it uses the same fonts as the media tools.
  - Never `typst watch` or `typst update`.
- **Monolith:** `monolith <url> -o <TempDir>/page.html -t 60 -M`, plus the options. "Render JavaScript first":
  1. `<edge|chrome> --headless=new --disable-gpu --user-data-dir=<TempDir>/profile --dump-dom <url>` writes the DOM to a temp file;
  2. then `monolith <file> -b <url> -I -o …`.

  The browser is found in its known install locations (not managed). If none is found, the toggle is disabled with a hint. No `--remote-debugging-*` flag ever.
- Everything goes through `core/proc` (tree kill on cancel), and outputs are registered with `job.Output`. Inputs are never touched. A converted output goes next to other outputs in `<library>/Documents/`; Web Archiver output goes in `<library>/Web Archive/<host>/`.

## 5. Modules

### 5.1 `modules/documents` (Document Converter)

```go
type Format string // "docx","odt","rtf","epub","html","md","gfm","latex","typst","ipynb","pptx","txt","pdf"
type Options struct {
    To            Format `json:"to"`
    PageSize      string `json:"pageSize"`      // "a4" | "letter" (pdf/typst)
    MarginMm      int    `json:"marginMm"`      // 10..50, default 25
    MainFont      string `json:"mainFont"`      // "" = default; from media.Fonts()
    FontSizePt    int    `json:"fontSizePt"`    // 9..16, default 11
    TOC           bool   `json:"toc"`
    NumberSections bool  `json:"numberSections"`
    ReferenceDoc  string `json:"referenceDoc"`  // docx/odt styles source; must exist
    EmbedResources bool  `json:"embedResources"` // html: --standalone --embed-resources (default true)
    ExtractMedia  bool   `json:"extractMedia"`  // md/html out: media into "<name>_media/"
}
```

- **Accepts:** `.docx .odt .rtf .epub .html .htm .md .markdown .tex .typ .ipynb .txt`.
- **Validate:**
  - rejects PDF input with a hint: "Pandoc can't read PDFs. Use OCR to get the text, then convert that."
  - rejects `pptx`/`pdf` as both input and output in the wrong direction.
  - rejects `to` equal to the input format.
- **Run:** one job per input, indeterminate progress (Pandoc reports none), and a 10-minute timeout.
- **Result:** the output file. For ExtractMedia, the folder is registered as an output too.
- **Pipeline:**
  - `DescribeStep`: Accepts documents; Produces role `document` (or `pdf`).
  - Templates: none.
  - Vars: `{format}`.

### 5.2 `modules/archiver` (Web Archiver)

```go
type Options struct {
    URLs         []string `json:"urls"`          // inputs are URLs, not files
    RenderJS     bool     `json:"renderJs"`
    NoJS         bool     `json:"noJs"`          // monolith -j
    NoImages     bool     `json:"noImages"`      // -i
    AlsoPDF      bool     `json:"alsoPdf"`       // browser --print-to-pdf
    TimeoutSec   int      `json:"timeoutSec"`    // 10..300, default 60
}
```

- **Validate:** http(s) URLs only. No `file:`. No loopback or private addresses unless the user ticks "Allow local addresses" (an Advanced option, off by default).
- **Output name:** `<page title or host> <yyyy-mm-dd>.html`.
- **Pipeline:**
  - Accepts URLs from a text input (a `.txt` / `.url` list);
  - Produces role `page` (+ `pdf`).

## 6. UI (minimal surfaces; kit tools)
- **Document Converter** (`tools/documents/`):
  - Kit layout: drop zone, file list (names, not paths), **Convert to** select (with format icons), primary **Convert**.
  - Advanced click-in: the options above, shown only when they apply to the target format.
  - Result rows: FileActions (Open, Reveal, Send to, Use when embedded). PDF results add ToolClickIns for PDF Toolkit "Make searchable" and "Compress".
  - Preview click-in: a first-page thumbnail for PDF (`core/pdfium`), and the text for md/html/txt (first 200 KB).
- **Web Archiver** (`tools/archiver/`):
  - A URL box (paste many, one per line), Render JavaScript / Also PDF toggles, primary **Save page**.
  - Result rows have Open in browser, Reveal, Send to, and a **Convert…** ToolClickIn (Document Converter, docx/md).
  - The "Render JavaScript" toggle explains in its tip that it uses the installed Edge/Chrome with a temporary profile.
- **OCR:** "Save as…" ToolClickIn (Document Converter with the recognised text as `.md` in TempDir → Use returns the converted file).
- **CompositionBar:** Document Converter Parts = `pdf`; Archiver Parts = `documents`.
- **Palette commands:** "Convert document…", "Save web page…".
- Everything must fit at 960×600.

## 7. Errors (`*core.AppError`)
- Pandoc exit ≠ 0 → `CodeToolFailed`. The message is the last stderr line; hints are mapped for the common cases:
  - missing image → "an image the document links to wasn't found";
  - unknown font → "pick another main font";
  - Typst compile error → "the PDF engine couldn't lay out the document; try HTML or docx".
- Monolith network errors → per-URL failure. The job keeps going for the others.
- No browser for RenderJS → a validation error with the hint "Install Edge or Chrome, or turn off Render JavaScript".

## 8. Tests
- **deps:**
  - asset/sha tables for both platforms;
  - the symlink-skipping extractor;
  - `Raw` part mode;
  - the Typst version gate.
- **documents:**
  - option → argv table tests (cwd = TempDir, data-dir, resource-path, pdf-engine path, RTS limits);
  - Validate tables;
  - `Run` against a fake pandoc (re-exec helper) that writes the output and a stray file into its cwd (asserting it stays in TempDir);
  - integration (tag `integration`): md → docx, docx → md, md → pdf (Typst), html → epub on generated samples.
- **archiver:**
  - URL validation (schemes, private ranges);
  - argv for monolith and the browser (asserting no `remote-debugging` flag ever);
  - a fake monolith;
  - integration against a local `httptest` page **only inside the test process** (the app never listens).
- **frontend:**
  - both views (empty, files, running, results, errors);
  - Advanced shows only the applicable options;
  - ToolClickIn wiring;
  - pipeline step UIs.

## 9. Work packages
The dep IDs, versions and installer module ids are already in `core/deps/deps.go` (`Pandoc`, `Typst`, `Monolith`, `*Version`, `*InstallModuleID`).

| Wave | WP | Scope | Owns |
|---|---|---|---|
| A | DA | deps: the three `ArchiveSpec`s + installer registration funcs (`RegisterPandocInstaller` etc., the Deno pattern), catalog `Spec`s (`AllowSystem` for pandoc/typst, version regexes, Typst ≥ 0.12 gate), `Raw` part mode, `.tar.xz`, symlink skipping; the Documents pack (sizes from the release API) | `core/deps/**`, `core/packs/**` |
| A | DB | `modules/documents` (options, module, service with `Defaults`/`Enqueue`, `pipeline.go`, tests with a fake pandoc) | `modules/documents/**` |
| A | DC | `modules/archiver` (same shape; browser discovery for Render JS) and removing the `archiver` placeholder | `modules/archiver/**`, `modules/placeholders/**` |
| — | architect | wire `main.go`, regenerate bindings, `lib/api.ts` exports, `tools/index.ts` lines, CLAUDE.md | |
| B | DD | Document Converter UI + OCR "Save as…" | `tools/documents/**`, `tools/ocr/**` |
| B | DE | Web Archiver UI + both pipeline step UIs | `tools/archiver/**`, `pipelines/steps/documents.tsx` |

## 10. Acceptance
1. A fresh install shows a Documents pack (~64 MB). Installing it makes both tools ready on macOS arm64 and Windows x64.
2. These conversions work, with nothing written next to the inputs and no file outside the library/support dirs:
   - md → docx;
   - docx → md (with media);
   - md → PDF (Typst, A4, TOC);
   - html → epub;
   - docx → html (one self-contained file).
3. A static article URL saves as one `.html` that opens offline. With Render JavaScript on, a JavaScript-rendered page saves its rendered content. No process ever opens a port (checked with `netstat` during the integration test).
4. Cancelling any job kills Pandoc + Typst / the browser tree within 3 s.
5. Send to / Use on every result; the CompositionBar chips open PDF Toolkit / Document Converter inside the host.
6. All checks pass; DECISIONS records the Calibre and SingleFile exclusions.

## 11. Resolved questions
- Calibre: not now (DECISIONS); Pandoc's EPUB covers ebooks.
- "Render JavaScript first" ships, off by default, temp profile, never a debugging port.
- Library folders: `<library>/Documents/` and `<library>/Web Archive/<host>/`.

## 13. Polish pass (2026-11-04, after Phase 12; uncommitted)

The user, looking at Pipelines: *"make it more polished and everything intentional and as compact as it can be. for example, this border is not needed since the entire page is in it. so just keep going on making this app really really usable and as spacious as it can be."* Baseline screenshots of every screen: `.dev/polish/base/<id>.png` (1180×720) and `.dev/polish/small/<id>.png` (960×600).

### 13.1 Rules (every screen)
1. **One header row per screen.** The shell's top bar holds the view title, the CompositionBar chips, the tool's own header and the global actions (Pop out, Search). A tool renders its header (document name, save state, undo/redo, More, primary action) with `<ToolHeader>` (`components/ToolHeader.tsx`): it portals into the shell's top bar (or a tool window's title bar) and renders inline when embedded or without a slot. `StudioLayout`'s `header` goes through it. Never a second 44 px header row under the top bar.
2. **No frames around a page.** A view's root is flush with the shell's content area: no outer border, radius, card background, margin or inset padding around the whole page. Regions are separated by a single 1 px `--line` divider, never by a gap plus borders. **Never a border inside a bordered region** (use a background step or a divider instead).
3. **Never repeat a title.** Not the tool name, not the view name (Settings' page h1, Pipelines' "Pipelines" tab + "Pipelines" breadcrumb), not the file name twice.
4. **Spacing scale.** Form pages: `--space-4` side padding, `--space-3`–`--space-4` between sections, section labels 11 px caps directly above their content. Workspace regions: `--space-2`–`--space-3`. Toolbars and bars: compact controls (28 px), 4–8 px gaps. Nothing taller than its content needs (drop zones shrink to one line once files are in; empty states are compact).
5. **Canvases run edge to edge** (graphs, stages, previews, timelines). Their tools float over them (overlay toolbars) instead of taking a row.
6. **Bottom bars of click-ins are one line** (`OneLineBar` of compact launchers with summaries), never a row of big cards.
7. **Taglines only in empty states.** A tool's one-line description shows when it has nothing loaded, not above a filled page.
8. **Dense lists.** Rows ≈ 32 px; secondary row actions appear on hover/focus (always reachable by keyboard); the primary action stays visible. Names not paths.
9. **Intentional width.** Form pages use the width they're given (no centered 700 px column with empty sides) unless it's reading text; multi-column grids collapse at 960 px.
10. Every screen still works at 960×600 with no page-level scroll for workspace tools and no clipped controls.

### 13.2 Packages
| WP | Scope | Owns |
|---|---|---|
| S | Shell top bar slot + `ToolHeader` portal (main window, tool windows, part windows), CompositionBar fitting next to a tool header, job tray (thinner), sidebar density; `StudioLayout`/`WorkspaceRail`/`OneLineBar`/`PartFrame` per the rules; the editor's header through `ToolHeader` | `shell/**`, `components/ToolHeader.*`, `workspace/**`, `parts/**`, `editor/EditorShell.*`, `editor/Rail.*` |
| P | Pipelines (the screenshot): no frame, no repeated titles, edge-to-edge graph, flush palette, one-line bottom bar, header through `ToolHeader`; Runs and the list view too | `tools/pipelines/**`, `pipelines/**` |
| K1 | The kit and the kit file tools | `tools/_kit/**`, `tools/{converter,stems,bpmkey,midi,transcribe,exif,bgremove,upscale,ocr,audiocleanup,documents}/**` |
| K2 | Custom-layout tools | `tools/{downloader,archiver,pdf,devutils,trimmer,redact,eraser,chat,vault,clipboard}/**` |
| W | Workspace tools' bodies (their headers move via `StudioLayout`) | `tools/{photo-composer,post-builder,subtitles,lyricvideo,visualizer}/**`, `blocks/**` |
| V | Library, Settings, setup screen, and the shared primitives | `views/**`, `components/**` (except `ToolHeader`, `ClickIn`, `ToolClickIn`), `styles/**` |
