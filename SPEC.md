# Toolbox — Phase 20 Spec: Smart search (find what's in your pictures and videos)

Status: **DRAFT 2026-11-18, waiting for your review.**

Phase 19 (Paint+ and the Library browser) is archived in `docs/specs/phase-19.md`. Every earlier rule still holds:
- **every tool stands on its own** (CLAUDE.md, 2026-11-06);
- every sidebar tool is a pipeline step with a `StepUI`;
- every file row is a draggable `ResultRow` with Send to, Reveal, Open and Save a copy;
- accessibility (a tooltip on every control, `aria-disabled` with a reason, keyboard reachability) and the 960 × 600 minimum always apply;
- the performance rules (2026-11-17): nothing slow before the window, fan-out through `core/par`, `d.ro` for reads.

---

## Overview

You asked for an image model that sees an apple and labels it "apple", like Google Photos search, for all assets and media. This phase adds that to the **Library**, the screen that already shows everything Toolbox made. It doesn't add a sidebar tool.

**What it does.** Once **Smart search** is installed, Toolbox looks at every picture, video and PDF in your library, in your projects and in any folder you add. It does this quietly in the background and on this machine only. Then:
1. **Search by what's in it.** Typing `apple`, `dog on a beach`, `receipt`, `sunset over water` or `screenshot of code` in the Library's search box finds the files that show it, best match first. Names still match too. Videos match at the moment that shows it (`0:42`), and clicking opens the video there.
2. **Labels.** Each file gets the few labels it clearly shows ("apple", "fruit", "table"), as chips in the detail panel. You can remove a wrong one and add your own. Clicking a chip shows everything with that label.
3. **Things.** A new Library view, like Google Photos' Explore, shows the labels you have the most of as cards with a cover picture (Food, Animals, Places, Documents, …). Click one to see them all.
4. **Find similar.** Any picture or video frame → "Find similar" shows the closest-looking files.

**How it works.**
- One local **vision–language model** turns each picture into a vector (an "embedding"). It turns your search text into a vector in the same space.
- Search compares the vectors, so it's **open-vocabulary**: it finds things nobody wrote a label for.
- The labels come from the same vectors scored against a frozen vocabulary of about 1,500 everyday words (§2.4), so labels cost nothing extra.
- **Model: SigLIP 2 ViT-B/16** (Google, Apache-2.0). It reads queries in many languages, and its scores are independent per label (a sigmoid), which makes "is there an apple?" a yes/no with a confidence rather than a ranking (Q1).
- It runs on the AI engine with onnxruntime. Search scoring runs in Go.

### Goals
- **It finds things.** In a library of a few thousand files, a typed concept (`apple`, `cat`, `whiteboard`, `birthday cake`) puts the right files at the top. Acceptance §6 checks it on real files.
- **Fast search.** Label and name matches show **instantly**. Concept matches show in **under 300 ms** once the engine is warm, and under 10 s from cold (the engine starts). A search never waits for indexing.
- **Unnoticeable indexing.** It runs one small batch at a time, only while no job of yours is running. It uses half the CPU cores, and you can pause it. Toolbox starts as fast as before.
- **Everything stays local.** The model downloads once, sha-verified, through the pack. After that, indexing and search make no network calls. Nothing about your files leaves the machine.
- **Always current.** New outputs are indexed within a minute of finishing. Renames, deletes and edits outside Toolbox are picked up at start and on rescan.

### Non-goals (this phase)
- **Faces and people** (grouping by person). That's a separate, opt-in privacy decision (Q4).
- **Places on a map** (GPS → city names needs an offline geocoder); **dates** are already a Library filter.
- **Searching speech or text inside files** (transcripts, OCR text). Later; the index is built so another source can be added (Q8).
- **Audio files.** There's nothing to see in them.
- **Clipboard history images and the Vault.** They're never indexed. Clipboard history stays private to its tool, and the Vault stays locked.
- **Generating or editing images.** This model only *reads* pictures.

---

## 1. Product

### 1.1 What a user can do (the standalone checklist)
- **Get it.** Library → the search box's hint row and Settings → Search both show "Search by what's in your pictures — install Smart search (≈ N GB)". The button installs the **Smart search** pack (AI engine + model, §2.7). Afterwards indexing starts by itself (Q2).
- **See progress.** A one-line status sits at the bottom of the Library's filter column (or the toolbar's More on narrow windows):
  - "Indexing 1,240 of 3,100 · Pause";
  - "Paused · Resume";
  - "Up to date · 3,100 files";
  - "Waiting for your jobs to finish";
  - "Indexing failed for 3 files · Show" (opens a list with each reason and Retry).
- **Search.** The existing search box ("Search outputs" becomes "Search names and what's in them"). Results show in the current view as one list, **best match first**:
  1. **Labels:** exact label or user-label matches, as a chip row above the results ("apple · 34", "apple pie · 2"). Clicking a chip filters by that label.
  2. **Concept matches:** sorted by score, each with a small match badge ("Strong", "Good", or "Maybe" for the weakest results, which show only when fewer than 12 strong or good ones exist).
  3. **Name matches:** files whose name contains the text, not already listed.

  The type, tool, date and folder filters still apply. Concept results arrive after the name and label results, and the list doesn't jump: they're inserted above the name matches, with focus and selection kept.
- **Video moments.** A video hit's card shows the matching frame with a time badge (`0:42`), not the poster. In the detail panel the player starts at that moment. "Other moments" lists up to 5 more matching frames of the same video.
- **PDF pages.** A PDF hit shows the matching page ("p. 3"), and the detail panel opens on that page.
- **Projects.** A project (painting, composition, edit, post) whose thumbnail matches shows with a "Project" badge. Opening it opens its tool, as in Places.
- **Labels in the detail panel.** "In this picture": up to 8 chips, strongest first. Hovering a chip shows its confidence. A chip's × hides that label for this file (it never comes back on re-index). "+ Label" adds your own (free text, ≤ 40 chars, offered as completions from the vocabulary and your earlier labels). Your own labels are searchable like auto labels and marked with a dot.
- **Things view.** A fifth Library view next to Grid / List / Folders / By tool:
  - sections by category: **People & events, Animals, Food & drink, Nature & places, Things, Vehicles, Documents & screens, Art & design**;
  - each label with ≥ 3 files is a card: a cover thumbnail (the file that scores highest) and a count;
  - your own labels form a **Your labels** section at the top;
  - click a card = Grid filtered by that label.
- **Find similar.** In the detail panel and the card context menu, for images, videos (the current frame) and PDFs (the current page). It shows the 60 closest files in Grid with a "Similar to <name> · Clear" chip.
- **Extra folders.** Settings → Search → "Also search these folders" → Add folder… (native folder picker; Q3).
  - **Read-only:** Toolbox never writes, renames or moves anything in those folders.
  - Their files show in search results and Things with a folder badge. Their cards have Open, Reveal, Save a copy and Send to. Rename and Delete are refused, as for any file outside the library.
  - Remove a folder → its index rows are deleted.
- **Exclude.** Settings → Search → "Skip these folders" (inside the library or an extra folder), e.g. `Received/` or a vault export folder.
- **Control.** Settings → Search:
  - "Index in the background" on/off (off = no new indexing; search still uses what's indexed);
  - Pause/Resume;
  - Rescan now;
  - "Rebuild index" (re-embeds everything, e.g. after a model change);
  - "Delete index" (removes every row and cached vector, keeps the model);
  - the index size on disk.
- **Search in pipelines.** A new step, **"Keep files that show…"** (§2.8). For example: watch Downloads → keep files showing "receipt" → Copy to `Receipts/`.

### 1.2 What gets indexed

| Source | What | Picture used |
|---|---|---|
| Library (`<library>/**`, registered and unregistered files) | images (incl. HEIC), videos, GIFs, PDFs | image: the whole picture, EXIF-oriented, ≤ 512 px; video: frames (§2.3); PDF: pages 1–4 |
| Projects (`projectdocs`, every kind) | the project's `thumb.jpg` / render | that file |
| Extra folders (Q3) | same kinds as the library | same |

- **Never indexed:**
  - `<support>/**`, except project thumbs;
  - Clipboard history (`clip_items`, `<support>/clipboard/`);
  - the Vault and `tmp/vault-open`;
  - hidden files and folders (`.*`, Windows hidden/system attribute);
  - symlinks and junctions (never followed);
  - skip-listed folders.
- **Limits:**
  - files over 2 GB (video) or 200 MB (image, PDF) are skipped with a reason;
  - images over 100 MP are decoded with `imaging`'s reduce path;
  - an extra folder stops at depth 12 and 200,000 files, and says so.

---

## 2. Architecture

### 2.1 Files
```
core/search.go                     types (frozen in Wave 0, §2.5)
core/mediaindex/                   the index: scan, queue, vector store, scoring, labels (no Wails, no modules)
  index.go        Index: Open/Close, Enqueue, Query, Similar, Things, Labels, SetUserLabel, Status
  vectors.go      fp16 codec, in-memory matrix, dot products (par over chunks)
  scan.go         library / project / folder walkers, skip rules, reconcile
  labels.go       vocabulary load, label scoring, thresholds
  scheduler.go    idle detection → batch jobs; pause; events
core/store/mediaindex.go           SQL for migration 0011
core/store/migrations/0011_media_index.sql
modules/mediaindex/                hidden Quiet job module "media-index" + the step module
  module.go       Descriptor (Hidden, Quiet, Requires engine), Run = one batch
  prepare.go      image → ≤512 px JPEG; video frames (FFmpeg); PDF pages (core/pdfium)
  models.go       pinned model files, ModelProvider ("search-default")
  vocabulary.tsv  frozen label vocabulary (§2.4)
  pipeline.go     the "Keep files that show…" step (core.Chainable)
sidecar/toolbox_sidecar/handlers/search.py   search.prefetch, search.embed_images, search.embed_text
api/search.go                      SearchService (Wails)
frontend/src/state/search.ts       status, query state, things
frontend/src/views/library/        search results merge, Things view, label chips, Find similar, status line
frontend/src/views/SettingsSearch.tsx
frontend/src/pipelines/steps/search.tsx
```

### 2.2 Storage (migration `0011_media_index.sql`)
```sql
-- One row per file (or project) the index knows.
CREATE TABLE media_items (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,     -- absolute; for projects the thumb path
  source      TEXT NOT NULL,            -- 'library' | 'project' | 'folder'
  source_ref  TEXT NOT NULL DEFAULT '', -- project id, or extra-folder id
  kind        TEXT NOT NULL CHECK (kind IN ('image','video','document')),
  size_bytes  INTEGER NOT NULL,
  mod_ms      INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending','done','failed','skipped')),
  reason      TEXT NOT NULL DEFAULT '', -- failed/skipped: one line for the user
  attempts    INTEGER NOT NULL DEFAULT 0,
  model       TEXT NOT NULL DEFAULT '', -- model id the vectors belong to
  indexed_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX media_items_state ON media_items(state, id);

-- One vector per picture: pos = -1 whole image, ms for video frames, page index for PDFs.
CREATE TABLE media_vectors (
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  pos     INTEGER NOT NULL,
  vec     BLOB NOT NULL,                -- float16 LE, L2-normalised, len = dim*2
  PRIMARY KEY (item_id, pos)
);

-- Labels: auto (from vectors), user (added), hidden (user removed an auto label).
CREATE TABLE media_labels (
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,                -- vocabulary id, or the user's text (trimmed, lowercased)
  source  TEXT NOT NULL CHECK (source IN ('auto','user','hidden')),
  score   REAL NOT NULL DEFAULT 1,      -- auto: 0..1 probability; user: 1
  pos     INTEGER NOT NULL DEFAULT -1,  -- the frame/page that scored best
  PRIMARY KEY (item_id, label)
);
CREATE INDEX media_labels_label ON media_labels(label, source, score DESC);

-- Text → vector cache (queries and vocabulary prompts), per model.
CREATE TABLE media_text_vectors (
  model   TEXT NOT NULL,
  text    TEXT NOT NULL,
  vec     BLOB NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (model, text)
);
```
- **Size:** 768 dims × 2 bytes ≈ 1.5 KB per vector. 10,000 photos plus 500 videos × 16 frames is about 27 MB.
- **Settings key `search`:** `{ enabled: bool, paused: bool, folders: [{id, path}], skip: [path] }`. The default is `enabled: true`, which only does anything once the model is installed (Q2).
- **Query cache:** query vectors are kept for the last 500 queries. The vocabulary's vectors are kept for as long as the model and vocabulary hash are the same.
- **Bookkeeping:** `media_items.path` follows Library `Rename` (the store updates both in one transaction). `Trash` and Forget delete the row. Removing an extra folder deletes its rows.

### 2.3 Indexing pipeline
1. **Find work** (`core/mediaindex/scan.go`):
   - **At start** (in main.go's deferred chores, 60 s after the window): reconcile the library, projects and extra folders. This is a stat walk only. A file is new if it has no row, and changed if its `size`/`mod_ms` differ (→ `pending`). Rows whose file is gone are deleted.
   - **Live:**
     - `library:added` → enqueue now;
     - project saves (`projectdocs` update hook) → enqueue the thumb;
     - Rename and Trash → update or delete.
   - **Extra folders** are rescanned every 30 min while the app runs (no file watcher, as in Phase 19), and on "Rescan now".
2. **Schedule** (`scheduler.go`):
   - submits one `media-index` batch job (≤ 32 files, newest first, library before folders) **only when no other non-quiet job is queued or running** and indexing is enabled and not paused;
   - it checks again on every `Jobs.Observe` change and every 15 s;
   - a user job submitted mid-batch doesn't cancel the batch. Batches are small (≈ 10–20 s), so a user job waits at most one batch for the engine.
3. **Prepare** (`modules/mediaindex/prepare.go`, inside the job, files in TempDir), with `core/par` (6 at a time):
   - **Image:** `imaging.ToReadable` (HEIC) → `imaging.Orient` → shortest side resized to 224 (the model's size) → JPEG q90.
   - **Animated GIF/WebP:** the first frame and the middle frame.
   - **Video:** probe the duration (`core/media`). Take frames at `max(2 s, duration/16)` steps, at most 16, with FFmpeg run in the TempDir (`-ss` before `-i`, one `select` graph through `-/filter_complex`, as the Phase 15 rule says). Then drop a frame whose 64-bit dHash (shared from `organize` into `core/imaging/dhash.go`) is within 6 bits of the previous kept frame. A still shot gives one vector.
   - **PDF:** pages 1–4 through `core/pdfium` at 224 px short side. Encrypted PDFs are skipped ("password protected").
4. **Embed:** one `search.embed_images` call per batch with every prepared path. It returns float16 vectors (base64) in order.
5. **Store:** in one write transaction per batch:
   - vectors, `state = done`, `model`, `indexed_at`;
   - auto labels (§2.4) recomputed in Go;
   - `user` and `hidden` rows are left alone.
6. **Failures:**
   - a file that fails to prepare → `failed` with the reason, retried once on the next start;
   - an engine crash → the batch is retried once, item by item; an item that crashes twice → `skipped` ("couldn't be read by the engine").
7. **Events:** `search:status` (`core.SearchStatus`, throttled to 2/s) and `search:indexed` (`{paths}` per batch) let open views refresh their label chips.
8. **Model change:** a new pinned model id marks every row `pending` (vectors are replaced batch by batch), and search keeps using the old vectors until each row is redone (a vector of the wrong model is skipped when scoring).

### 2.4 Labels
- **Vocabulary** (`modules/mediaindex/vocabulary.tsv`, embedded, frozen data):
  - columns `id`, `category`, `display`, `prompts` (`|`-separated, `{}` = the display word), `threshold` (optional override);
  - about 1,500 everyday concepts across the eight categories in §1.1;
  - each has 1–3 prompts, e.g. `a photo of an apple|an apple`;
  - Documents & screens has `screenshot`, `receipt`, `whiteboard`, `slide`, `code`, `chart`, `handwriting`, `map`, `poster` …;
  - Art & design has `painting`, `sketch`, `illustration`, `logo`, …;
  - **no identity labels**: no named people, no ethnicity or gender, and no "person's name". People & events has `person`, `group of people`, `selfie`, `wedding`, `birthday`, `concert`, ….
  - Parent links (`apple` → `fruit` → `food`) are a fourth column `parent`. A child label always adds its parent.
- **Scoring (Go):** `p = sigmoid(scale · (img · text) + bias)`.
  - `scale` and `bias` are the model's own pinned constants, and `text` is the mean of the label's prompt vectors, re-normalised.
  - A label is kept if `p ≥ threshold` (the default comes from the Wave 0 calibration, §7, about 0.1 for SigLIP).
  - An item keeps at most 8 labels (plus their parents). Videos and PDFs take the max over their frames or pages and remember `pos`.
- **Text search uses the same score.** "Strong" is p ≥ 0.3, "Good" is p ≥ 0.1, "Maybe" is p ≥ 0.03, all calibrated in Wave 0 and stored in `labels.go` as constants. Below "Maybe" nothing shows. So a query for something that isn't in the library shows **no concept results**, rather than the 50 least-bad ones.
- **Changing the vocabulary** recomputes auto labels from stored vectors (no re-embedding), which takes seconds.

### 2.5 Go contracts (frozen in Wave 0)
```go
// core/search.go
type SearchQuery struct {
    Text     string       `json:"text"`     // free text; "" = labels/filters only
    Labels   []string     `json:"labels"`   // all must match (auto or user, not hidden)
    Similar  string       `json:"similar"`  // path; with SimilarPos for a frame/page
    SimilarPos int64      `json:"similarPos"`
    Filter   LibraryQuery `json:"filter"`   // kinds, module, since/until, folder (Search/Sort/Cursor ignored)
    Sources  []string     `json:"sources"`  // empty = library+project+folder
    Limit    int          `json:"limit"`    // default 200, max 500
}
type SearchHit struct {
    Path      string  `json:"path"`
    Source    string  `json:"source"`    // library | project | folder
    ProjectID string  `json:"projectId"`
    Output    *Output `json:"output"`    // when it's a library output
    Kind      OutputKind `json:"kind"`
    Score     float64 `json:"score"`     // 0..1 (label/user hits = 1)
    Strength  string  `json:"strength"`  // strong | good | maybe | label | name
    Pos       int64   `json:"pos"`       // -1, video ms, or PDF page
    Moments   []int64 `json:"moments"`   // other matching positions (≤ 5)
    Via       string  `json:"via"`       // "label:apple", "concept", "name"
}
type SearchPage struct {
    Hits      []SearchHit  `json:"hits"`
    Labels    []LabelCount `json:"labels"`    // labels matching Text (prefix), for the chip row
    Concept   bool         `json:"concept"`   // concept scoring ran (false: engine/model missing or warming)
    Warming   bool         `json:"warming"`   // the text vector is being computed; call again
}
type LabelCount struct { Label, Display, Category string; Count int; User bool; Cover string }
type MediaLabel struct { Label, Display, Source string; Score float64; Pos int64 }
type SearchStatus struct {
    Installed, Enabled, Paused, Waiting bool
    Total, Done, Pending, Failed, Skipped int
    Current string; Model string; IndexBytes int64; LastError string
}
type SearchFolder struct { ID, Path string; Files int; Missing bool }
type SearchFailure struct { Path, Reason, State string; Attempts int; At int64 }
```
`api/search.go`, `SearchService`:
```go
Status() core.SearchStatus
Query(q core.SearchQuery) (core.SearchPage, error)  // names+labels synchronously; concept part via cache or Warming=true + search:ready event
Things() ([]core.LabelCount, error)
Labels(path string) ([]core.MediaLabel, error)
SetLabel(path, label string, on bool) error         // user add / hide auto / remove user
Failures(limit int) ([]core.SearchFailure, error); Retry(paths []string) error
SetEnabled(on bool) error; SetPaused(on bool) error; Rescan() error; Rebuild() error; DeleteIndex() error
Folders() ([]core.SearchFolder, error); AddFolder() (core.SearchFolder, error) /* dialog */; RemoveFolder(id string) error
SetSkip(paths []string) error
Warm()                                               // starts the engine + text model when the search box gets focus
```
- **Concept scoring:**
  - all vectors of the current model are loaded lazily into one `[]float32` matrix (fp16 → fp32) on the first query;
  - they're kept current on writes and dropped after 10 idle minutes;
  - scoring is a dot product per vector, fanned out with `par` over 4096-row chunks; 100k vectors take ≈ 20 ms;
  - an item's score is the max over its vectors.
- **The text vector** comes from the cache, or from `search.embed_text`. When it isn't cached, `Query` returns the names and labels at once with `Warming: true`, then emits `search:ready {text}` once the vector is in. The UI asks again, and that second answer comes from the cache.
- **Filters** are applied after scoring via `outputs` joins (library hits) or `media_items` (others).

### 2.6 AI engine (`handlers/search.py`)
- **`search.prefetch {model:{files:[{file,url,sha256}]}, modelDir}`** downloads and verifies the files with `download.ensure_model`, as bgremove does.
- **`search.embed_images {modelDir, files, paths[], threads}`** → `{dim, vectors: [base64 fp16]}`, with progress per image.
  - Preprocessing: RGB, resized to 224 × 224 bicubic (SigLIP squashes rather than crops), scaled to `[-1, 1]` (mean 0.5, std 0.5), batched by 16, L2-normalised.
  - It keeps one resident visual session; `threads` = half the cores (`intra_op_num_threads`).
- **`search.embed_text {modelDir, files, texts[]}`** → the same shape.
  - The tokenizer comes from the model's `tokenizer.json` through `tokenizers` (already locked, via faster-whisper), with SigLIP's fixed length of 64 tokens, padded.
  - The text session loads on the first call and is dropped after 5 minutes unused, which keeps RSS low while indexing.
- The handler never downloads, and `ctx.check_cancelled()` runs between batches.
- **Tests** run against a tiny generated ONNX model (random linear projection, dim 8) and a toy `tokenizer.json`, plus slow tests with the real model (`TOOLBOX_SLOW=1`): "a photo of an apple" scores higher on a generated red-apple image than on a generated blue square.

### 2.7 Model and pack
- **The model:** SigLIP 2 ViT-B/16 at 224 px (`google/siglip2-base-patch16-224`, Apache-2.0, trained on WebLI). It comes as split ONNX visual and textual files plus `tokenizer.json`, from Immich's export (`immich-app/ViT-B-16-SigLIP2__webli`). Wave 0 confirms the file list, URLs, sha256, sizes, `scale`/`bias` and dim, and pins them in `modules/mediaindex/models.go`. The files go to `<models>/search/siglip2-b16/`.
  - If that repo's files can't be pinned (missing, or no text tower), Wave 0 exports them once from the official checkpoint with the same script as Immich. It hosts nothing: it records the decision and falls back to Q1's alternative model, which has a known ONNX export.
- **The component** `search-default`, "SigLIP 2 image understanding", Apache-2.0, sizes measured in Wave 0.
- **A new pack, `search` "Smart search"** (icon `scan-search`): the components `engine` and `search-default`; it unlocks `media-index`. It is also listed as an optional extra in the **Image** pack's description. The packs test is extended for a pack whose unlock is a hidden module (DECISIONS).
- **Model files** are never copied into a job and never leave `<models>`.

### 2.8 Pipeline step: "Keep files that show…" (`search-filter`)
- **Options:** `query` (text, template), `strength` (`strong` | `good` | `maybe`, default `good`), `invert` (keep those that *don't*).
- **Behaviour:** files pass through untouched. Each file's vector comes from the index if it's indexed and current; otherwise it's embedded inside the step's job, the same way (prepare + `search.embed_images`), and **not** added to the index unless it's in an indexed place.
- **Outputs:** role `kept` (matching) and role `other` (the rest), plus the variables `matched` (count, number) and `best` (top label of the first file, text).
- It's a hidden job module (`search-filter`, Requires the engine) with a `StepUI` in `pipelines/steps/search.tsx`, in the step picker under "Organise". The module is non-built-in and hidden, so it's in the `search` pack's unlocks.

---

## 3. UI details
- **Search box:**
  - the placeholder is "Search names and what's in them";
  - a hint row under it (the first time, or with the model missing) says "Try: apple, dog on a beach, receipt";
  - focus calls `SearchService.Warm()` (at most once a minute).
- **Results:** concept hits replace the normal page while a query is active, and sort is fixed to "Best match" (the sort menu shows that and is disabled with a reason). Paging is client-side over ≤ 500 hits. All four existing views render hits; Folders view shows them flat with the folder under the name.
- **Card additions:** a strength dot (Strong/Good/Maybe, tooltip shows the %); a time badge for video moments; "p. N" for PDF pages; a folder badge for extra-folder files; a "Project" badge.
- **Chips:**
  - the chip row above results (labels) and the active-label chips in the filter bar use the existing `Chip` component;
  - label chips are neutral, and user labels have a dot (not a colour: value colours are reserved for pipeline types);
  - chips never wrap, and extra ones collapse to "+N".
- **Detail panel:**
  - "In this picture" sits under the metadata (chips, "+ Label", "Find similar");
  - for video it also has "Moments" (a strip of matching frames when a query is active).
- **The Things view** is a grid of label cards by category with sticky category headers, and it virtualises above 300 cards.
- **The status line:**
  - lives in the Library's filter column, or More → Search status at 960 px;
  - clicking it opens Settings → Search;
  - with the engine or model missing, a `DepsGate`-style one-liner shows instead, with the `search` pack button.
- **Settings → Search** (`SettingsSearch.tsx`), a form page:
  - status with Pause/Resume;
  - Index in background;
  - Also search these folders (list + Add/Remove);
  - Skip these folders;
  - Rescan now, Rebuild index, Delete index (confirm, which names the size);
  - the model's origin line: "SigLIP 2 by Google, trained on WebLI (web images with alt text); Apache-2.0; runs on this computer."
- **The palette:** "Search pictures for…" (opens the Library with the box focused), "Find similar to selected", and "Pause indexing" / "Resume indexing".
- **Layout:** works at 960 × 600 (the chip row collapses, the status goes into More) and 1180 × 720.

---

## 4. Errors and limits
- **Engine or model missing:** search works on names and user labels. `Concept: false`, and the gate line names the pack.
- **Engine busy or crashed during a query:** names and labels still show, and concept results say "Couldn't search pictures right now · Try again". It never shows a blank page.
- **An unreadable file:** `failed` with the reason (corrupt, unsupported codec, password protected, too large), listed under "Show" with Retry.
- **An extra folder that went missing** (unplugged drive): shown as "Missing" in Settings. Its rows are kept for 30 days, and its hits are hidden until it returns.
- **Index DB errors:** indexing stops and the status shows "Indexing stopped: <reason>". Search falls back to names. The app isn't affected.
- **Memory:** the in-memory matrix is capped at 512 MB (≈ 170k vectors at fp32). Above that, scoring streams from SQLite in chunks (slower; the status says "Large index").

## 5. Tests
- **Go:**
  - `core/store`: migration 0011 from a 0010 fixture; cascades; rename and trash keep `media_items` in step; text cache LRU.
  - `core/mediaindex`:
    - the fp16 codec (round-trip within 1e-3);
    - scoring top-k matches a naive reference;
    - label thresholds, parents and `hidden` that survives re-index;
    - the skip rules (table: hidden files, symlinks, support dir, clipboard dir, vault dir, skip-list);
    - reconcile (new, changed, gone);
    - the scheduler only submits when idle and respects pause;
    - a model change marks rows pending;
    - the 512 MB fallback.
  - `modules/mediaindex`:
    - prepare (image orientation, HEIC via a fake converter, GIF frames, video frame selection and dHash dedupe against a generated test video, PDF pages, an encrypted PDF skipped);
    - `Run` against a fake `Caller`;
    - `Chainable` (describe, prepare, outputs with roles, invert).
  - `api`: `Query` merges label, concept and name hits in order without duplicates; `Warming`, then the cached result; filters; extra folders refused for Rename/Trash.
  - Root: the packs test (the `search` pack), `pipeline_proof_test` (`search-filter`), and the vocabulary test (unique ids, valid categories, parents exist, no banned identity words, every prompt has a `{}` or is literal).
- **Python:** the tiny-model tests (§2.6), tokenizer padding, batch order, cancel between batches; slow real-model tests.
- **Frontend (vitest):**
  - results merge and the no-jump insertion;
  - chips (add, hide, completion);
  - the Things view from fixtures;
  - Find similar flow;
  - the status line in each state, and the gate when missing;
  - `SettingsSearch` (folders, delete confirmation);
  - the step `StepUI` and its params labels (`steps/params.test.ts`);
  - 960 × 600 via media-query mocks.

## 6. Acceptance (on the Windows PC, a real build, sandbox env)
1. Install the **Smart search** pack from the Library's prompt. Indexing starts on its own, the status counts up, and the app stays responsive. A Converter job submitted mid-index starts within one batch.
2. A sample set in the sandbox library (Wave 0 picks real photos from `.dev/` research inputs and the library, plus a few you add: an apple, a dog, a receipt, a screenshot, a sunset, a short video with a dog appearing after 20 s, a 3-page PDF with a chart on page 2):
   - `apple` → the apple photo is in the top 3, with the label chip "apple · 1+";
   - `dog` → the dog photo and the video, the video with a moment badge after 0:20; clicking plays from that moment;
   - `receipt`, `screenshot`, `sunset`, `chart` (the PDF, "p. 2") are each in the top 3;
   - `pomme` (French) → the apple photo;
   - `giraffe` (none in the set) → no concept results, just "No pictures match 'giraffe'".
3. The detail panel of the apple shows "apple" and "fruit". Hide "fruit", Rebuild index: it stays hidden. Add the label "lunch", then search `lunch`: found.
4. The Things view shows Food & drink with an apple card. Find similar on the dog photo puts the dog video frame in the top 5.
5. Add an extra folder with 20 photos: they're indexed and searchable, and nothing in that folder changed (hash before/after). Remove it, and its hits are gone.
6. Restart the app: the index persists, and start-up time is unchanged (±5% vs before, measured as in the performance pass).
7. Pull the network cable (or block outbound) after install: indexing and search still work.
8. Clipboard history images and vault files never appear in search (checked by putting an apple picture into clipboard history).
9. A pipeline: folder watch → "Keep files that show… receipt" → Copy to `Receipts/` copies only the receipts.
10. Screens at 1180 × 720 and 960 × 600 (survey shots in `.dev/p20-qa/`), light and dark.

---

## 7. Work packages

### Wave 0 — foundation (architect, sequential, on main)
1. CLAUDE.md "Smart search (Phase 20)" section; DECISIONS entries for the Q defaults; ROADMAP row.
2. **Spike: the model**, recorded in DECISIONS:
   - confirm the Immich SigLIP 2 B/16 export (files, sha256, sizes, `dim`, `scale`/`bias`, tokenizer length) and pin it;
   - time visual and text embedding on this PC (images/s at batch 16, half the cores; cold text-model load);
   - measure RSS while indexing.
   If the files aren't usable, apply the fallback in §2.7 and say so in DECISIONS.
3. Migration 0011 and store stubs; `core/search.go` types; `core/mediaindex.Index` interface with stubs; `SearchService` stubs; the `media-index` and `search-filter` module skeletons (Descriptors, `Options`, `Chainable` with real `StepDefaults`/`DescribeStep`); `handlers/search.py` stub (methods registered, `not_implemented`); the pack and component in `core/packs`; wiring in `main.go`; events in `api/events.go`; icons (`scan-search`, `tags`); `SettingsSearch.tsx` placeholder in Settings; the stub `StepUI` and `paramDefs`.
4. Move `dHashImage` from `modules/organize` to `core/imaging/dhash.go` (exported; organize uses it).
5. **Vocabulary draft** (`vocabulary.tsv` format + about 300 labels, enough for tests) and the calibration harness: `go test -tags calibrate ./modules/mediaindex/` scores a labelled folder (`TOOLBOX_CALIBRATE_DIR`, a `labels.csv` of file → expected labels) and prints precision/recall per threshold.
6. Regenerate bindings and re-export from `lib/api.ts`. All checks green.

### Wave 1 — parallel builders

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **S1 Engine** | `search.prefetch/embed_images/embed_text`, the tiny-model fixtures, slow tests, `ModelProvider` in `models.go` | `sidecar/toolbox_sidecar/handlers/search.py`, `sidecar/tests/test_search.py`, `sidecar/tests/fixtures/search/**`, `modules/mediaindex/models.go` | Wave 0 |
| **S2 Index** | `core/mediaindex/**` (scan, reconcile, scheduler, vectors, scoring, labels), `core/store/mediaindex.go`, the rename/trash hooks, `modules/mediaindex` job (`module.go`, `prepare.go`), deferred-chores wiring | `core/mediaindex/**`, `core/store/mediaindex.go`, `modules/mediaindex/{module,prepare}.go` (+ tests), the hook lines in `api/library_actions.go` and `core/projectdocs` | Wave 0 (S1's engine is faked) |
| **S3 Search API** | `SearchService`: query merge and ranking, warming and `search:ready`, things, labels, failures, folders (dialog), settings | `api/search.go` (+ tests) | Wave 0 (the `Index` interface; a fake until S2 merges) |
| **S4 Library + Settings UI** | search results merge, chip row, card badges, the Things view, detail panel labels/moments/Find similar, the status line and gate, `SettingsSearch`, palette commands | `frontend/src/views/library/**`, `frontend/src/state/search.ts`, `frontend/src/state/library.ts` (search fields only), `frontend/src/views/SettingsSearch.tsx` (+ css/tests), `shell/keywords.ts` (entries only) | Wave 0 (bindings) |
| **S5 Step** | the `search-filter` job and `Chainable`, `pipelines/steps/search.tsx`, `paramDefs` entries | `modules/mediaindex/pipeline.go` (+ test), `modules/mediaindex/filter.go`, `frontend/src/pipelines/steps/search.tsx`, its `paramDefs` lines | Wave 0 |
| **V1 Vocabulary** | the full ≈ 1,500-label `vocabulary.tsv` (categories, prompts, parents, no identity labels), and the vocabulary test | `modules/mediaindex/vocabulary.tsv`, `modules/mediaindex/vocabulary_test.go` | Wave 0 (format) |

### Wave 2 — after Wave 1 merges
- **I1 Integration** (architect):
  - S1 + S2 + S3 end to end with the real model on this PC;
  - calibration of the thresholds and the Strong/Good/Maybe cut-offs on the acceptance set (written into `labels.go` with the numbers in DECISIONS);
  - the acceptance run §6;
  - start-up timing;
  - QA shots;
  - the CLAUDE.md final pass.

---

## 8. Open questions (defaults chosen; change them before approving)
- [ ] **Q1 Which model.**
  - **Default: SigLIP 2 ViT-B/16** (Apache-2.0). It understands queries in many languages, its per-label confidence is real (sigmoid), and it's much more accurate than the original CLIP.
  - Its cost is size: about **1.5 GB** on disk (≈ 0.4 GB picture side, ≈ 1.1 GB text side, because of its multilingual vocabulary), to be measured in Wave 0.
  - **Alternative: OpenAI CLIP ViT-B/32** (MIT, ≈ 0.6 GB, English only, noticeably weaker on specific things).
- [ ] **Q2 Index automatically once installed.** **Default: yes.** Installing the pack is the opt-in. Indexing runs only when idle, can be paused, and everything stays on this machine. The alternative is a "Start indexing" button after install.
- [ ] **Q3 Folders outside the library** (e.g. your Pictures folder). **Default: yes, opt-in per folder, read-only.** Without it, search only covers what Toolbox made, which may be less than you meant by "all assets and media".
- [ ] **Q4 Faces and people.** **Default: not this phase.** Grouping by person needs a face-recognition model and stores face prints, a privacy decision of its own. It would be a separate opt-in pack later. "person", "selfie" and "group of people" are labels now.
- [ ] **Q5 Received files and vault exports.** **Default: indexed like the rest of the library.** "Skip these folders" excludes any of them.
- [ ] **Q6 Where it lives.** **Default: inside the Library** (search box, Things view, detail panel), plus Settings → Search. No new sidebar tool.
- [ ] **Q7 The pipeline step "Keep files that show…".** **Default: yes**, because it makes watch folders sort by content.
- [ ] **Q8 Text inside files.** **Default: later.** Searching OCR text in screenshots and receipts, and transcripts of videos, would feed the same search box from the existing OCR and Transcribe engines. It would be a natural next phase.

### Later
- Faces/people (Q4), places from GPS, OCR text and transcripts in search (Q8).
- "Memories"-style collections (on this day, trips).
- GPU execution providers (DirectML on Windows, CoreML on Mac) for faster indexing.
- Search inside Paint+'s reference picker and the Library picker (`pickFromLibrary`) with the same box.
- Duplicate and near-duplicate finder in the Library using the stored vectors.
