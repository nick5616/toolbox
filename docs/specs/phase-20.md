# Toolbox — Phase 20 Spec: Smart search and Caption Writer

Status: **APPROVED 2026-11-18, built the same day; acceptance run finished 2026-11-19** (see docs/DECISIONS.md, Phase 20).

Phase 19 (Paint+ and the Library browser) is archived in `docs/specs/phase-19.md`. Every earlier rule still holds:
- **every tool stands on its own** (CLAUDE.md, 2026-11-06);
- every sidebar tool is a pipeline step with a `StepUI`;
- every file row is a draggable `ResultRow` with Send to, Reveal, Open and Save a copy;
- accessibility (a tooltip on every control, `aria-disabled` with a reason, keyboard reachability) and the 960 × 600 minimum always apply;
- the performance rules (2026-11-17): nothing slow before the window, fan-out through `core/par`, `d.ro` for reads.

---

## Overview

This phase has two parts.

**Part A — Smart search** (in the Library, no new sidebar tool).
- Once the **Smart search** pack is installed, Toolbox indexes everything in your library, quietly and on this machine only. It indexes:
  - **what's in every picture, video and PDF page**, with a local vision–language model;
  - **the text inside files**: words in pictures and scans (OCR), PDF and document text, and **speech** in videos and audio (transcripts).
- After that, in the Library:
  1. **Search by what's in it.** `apple`, `dog on a beach`, `receipt` or `sunset` finds the files that show it, best match first. Videos match at the moment (`0:42`), and PDFs at the page.
  2. **Search by what it says.** `invoice 4471` finds the screenshot with that number in it. `quarterly budget` finds the meeting recording at the minute someone said it. A snippet shows the match.
  3. **Labels.** Each file gets the few labels it clearly shows ("apple", "fruit"). You can hide a wrong one, add your own, and click one to see all.
  4. **Things view.** Like Google Photos' Explore: label cards by category with cover pictures.
  5. **Find similar.** For any picture, video frame or PDF page.

  Names still match as before.

**Part B — Caption Writer** (a new tool, `captions`).
- **What it does.** It writes the words that go *with* your pictures and videos, with a local vision model that looks at them:
  - **alt text** (for accessibility);
  - **descriptions**;
  - **social captions with hashtags**;
  - **keywords**;
  - **file names**.
- **How you use it.** Give it a batch with a line of context ("our trip to Lisbon, May 2026; the dog is Max"). It writes all of these per file. You edit them, then:
  - copy them;
  - save them as CSV, JSON or text files;
  - **write them into copies of the files** (the alt-text and description metadata fields that websites, Lightroom and screen readers read);
  - or **rename copies** by content.
- **What's new.** Nothing in Toolbox does this today. Subtitles and Transcribe caption *speech*, and Post Builder has an empty caption box you fill in by hand.
- **How it connects.** It plugs into Post Builder ("Write with Caption Writer") and pipelines ("rename every photo by what's in it"). It feeds Smart search: words in your captions become searchable.

### Goals
- **It finds things.**
  - In a library of a few thousand files, a typed concept puts the right files at the top.
  - A typed word or number that appears in a picture, a PDF, a document or speech finds that file.
  - Acceptance §7 checks this on real files.
- **Fast.** Label, name and text matches show **instantly** (SQLite). Concept matches take **under 300 ms** once the engine is warm, and under 10 s from cold. A search never waits for indexing.
- **Unnoticeable.**
  - Indexing runs one small batch at a time, only while no job of yours is running, on half the CPU cores, and you can pause it.
  - Speech transcription runs last and lowest.
  - Start-up is as fast as before.
- **Local.** Models download once, sha-verified, through packs. After that, indexing, search and captioning make no network calls. Nothing about your files leaves the machine.
- **Captions you'd actually post.** They're specific, grounded in what's visible plus your context, in your chosen tone, length and language. They never guess who a person is.

### Non-goals (this phase)
- **Faces and people.** No grouping by person and no face prints; a separate opt-in later. The vision model **never identifies people**. Names come only from your context.
- **Folders outside the library** (you chose library-only; see Later).
- **Places from GPS.** Dates are already a Library filter.
- **Clipboard history images and the Vault.** They're never indexed and never captioned automatically (Caption Writer accepts any file you hand it).
- **Generating or editing pictures.** Both models only *read* pictures.
- **Auto-captioning the whole library** with the vision LLM. It's too slow for background work. Smart search labels and text are the background layer, and Caption Writer runs on what you choose.

---

# Part A — Smart search

## 1. Product

### 1.1 What a user can do
- **Get it.** Library → the search box's hint row and Settings → Search both show "Search by what's in your pictures and what your files say — install Smart search (≈ N GB)". The button installs the **Smart search** pack (§3.8). **Indexing starts by itself afterwards.**
- **See progress.** A one-line status sits in the Library's filter column (More → Search status at 960 px):
  - "Indexing pictures 1,240 of 3,100";
  - "Reading text 80 of 300";
  - "Transcribing 2 of 14 (meeting.mp4)";
  - "Paused · Resume";
  - "Waiting for your jobs to finish";
  - "Up to date · 3,100 files";
  - "3 files couldn't be indexed · Show" (a list with reasons and Retry).

  Clicking it opens Settings → Search.
- **Search.** The search box says "Search names, what's in pictures and what files say". Results are one list, best first:
  1. **A label chip row** above the results ("apple · 34", "apple pie · 2"). Clicking a chip filters by that label.
  2. **Matches:** concept and text hits merged by score (§3.6). Each card shows a strength dot (Strong / Good / Maybe). A text hit shows a **one-line snippet** with the matched words in bold ("…total **4471** due 30 Nov…") and an icon for where it was found: picture text, PDF/document, or speech.
  3. **Name-only matches** not already listed.

  The type, tool, date and folder filters still apply. Sort is fixed to "Best match" while a query is active (the sort menu says why). Concept results arrive after the instant ones, and they're inserted without moving focus or selection.
- **Moments and pages.**
  - A video hit shows the matching frame or speech moment with a time badge (`0:42`), and the detail panel starts the player there. "Other moments" lists up to 5 more.
  - A PDF or document hit shows "p. 3" (or "slide 3"), and the detail panel opens on that page.
- **Projects.** A project whose thumbnail matches shows with a "Project" badge. Opening it opens its tool, as in Places.
- **Detail panel.**
  - **"In this picture":** up to 8 label chips, strongest first, with confidence on hover. × hides an auto label for good. "+ Label" adds your own (free text, ≤ 40 chars, with completions from the vocabulary and your labels). Your labels have a dot.
  - **"Find similar."**
  - **"Text in this file":**
    - the OCR text, PDF/document text or transcript, scrollable;
    - transcript lines carry timestamps (clicking one seeks the player);
    - OCR text says which frame or page it came from;
    - there's Copy, Save as .txt… and, for speech, Save as .srt…;
    - the search terms are highlighted;
    - "Read again" re-runs OCR or transcription for that file.
  - **"Caption"** (when Caption Writer wrote one): its alt text and caption, and "Open in Caption Writer".
- **Things view.** A fifth view next to Grid / List / Folders / By tool:
  - sections **People & events, Animals, Food & drink, Nature & places, Things, Vehicles, Documents & screens, Art & design**, and **Your labels** first;
  - a card per label with ≥ 3 files: the cover (highest score) and a count;
  - a click opens Grid filtered by that label;
  - it virtualises above 300 cards.
- **Find similar** (detail panel, card context menu; images, video frames, PDF pages) shows the 60 closest files, with a "Similar to <name> · Clear" chip.
- **Settings → Search:**
  - status with Pause/Resume;
  - "Index in the background";
  - "Read text in pictures and PDFs";
  - "Listen to speech in videos and audio";
  - "Transcribe automatically up to [60] min per file";
  - "Skip these folders" (inside the library, e.g. `Received/`);
  - Rescan now, Rebuild index, Delete index (a confirmation that names the size);
  - the index size on disk;
  - the model origin lines (§3.8).
- **The palette:** "Search pictures and text for…", "Find similar to selected", "Pause indexing" / "Resume indexing".
- **Pipelines:** a new step, **"Keep files that show…"** (§3.9).

### 1.2 What gets indexed

| Kind | Picture index (vectors + labels) | Text index |
|---|---|---|
| Images (incl. HEIC, GIF, WebP) | the whole picture, oriented, 224 px; GIF/WebP: first + middle frame | OCR, when the picture looks like it has text (§3.4) |
| Videos | up to 16 frames (§3.3) | OCR of frames with text; **speech** (§3.5) |
| Audio | — | **speech** (§3.5) |
| PDFs | pages 1–4 | the text layer of every page (≤ 500); OCR of pages without one (≤ 50) |
| Documents: `.txt .md .csv .json .srt .vtt .lrc .ass .html .htm .docx .pptx .xlsx .odt .odp .ods .epub` | — | extracted text (first 2 MB of text) |
| Projects (`projectdocs`, every kind) | the project's `thumb.jpg` | — |

- **Scope:**
  - the **library only** (`<library>/**`, registered and unregistered files), plus project thumbnails;
  - **never:** `<support>/**` except project thumbs, clipboard history, the Vault and `tmp/vault-open`, hidden files/folders (`.*`, Windows hidden/system attribute), symlinks and junctions (never followed), and skip-listed folders.
- **Limits:**
  - files over 4 GB (video/audio) or 200 MB (image, PDF, document) are skipped with a reason;
  - images over 100 MP use `imaging`'s reduce path;
  - encrypted PDFs are skipped ("password protected").

---

## 2. Storage (migration `0011_media_index.sql`)
```sql
CREATE TABLE media_items (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,      -- absolute; for projects the thumb path
  source       TEXT NOT NULL CHECK (source IN ('library','project')),
  source_ref   TEXT NOT NULL DEFAULT '',  -- project id
  kind         TEXT NOT NULL CHECK (kind IN ('image','video','audio','pdf','doc')),
  size_bytes   INTEGER NOT NULL,
  mod_ms       INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','done','failed','skipped')),  -- pictures + text stage
  speech_state TEXT NOT NULL DEFAULT 'none' CHECK (speech_state IN ('none','pending','done','failed','skipped','nospeech')),
  reason       TEXT NOT NULL DEFAULT '',  -- one line for the user (failed/skipped)
  attempts     INTEGER NOT NULL DEFAULT 0,
  model        TEXT NOT NULL DEFAULT '',  -- vision model id of the vectors
  indexed_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX media_items_state ON media_items(state, id);
CREATE INDEX media_items_speech ON media_items(speech_state, id);

-- pos: -1 whole image, ms for video frames, page index for PDFs.
CREATE TABLE media_vectors (
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  pos     INTEGER NOT NULL,
  vec     BLOB NOT NULL,                  -- float16 LE, L2-normalised
  PRIMARY KEY (item_id, pos)
);

CREATE TABLE media_labels (
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,                  -- vocabulary id or the user's text (trimmed, lowercased)
  source  TEXT NOT NULL CHECK (source IN ('auto','user','hidden')),
  score   REAL NOT NULL DEFAULT 1,
  pos     INTEGER NOT NULL DEFAULT -1,
  PRIMARY KEY (item_id, label)
);
CREATE INDEX media_labels_label ON media_labels(label, source, score DESC);

-- Text inside files, one row per chunk (≤ ~1,000 chars, split on line/segment boundaries).
CREATE TABLE media_text (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  source  TEXT NOT NULL CHECK (source IN ('ocr','pdf','doc','speech','subs','caption')),
  pos     INTEGER NOT NULL,               -- -1 | video/audio ms | page/slide index
  end_pos INTEGER NOT NULL DEFAULT -1,    -- speech chunk end ms
  text    TEXT NOT NULL
);
CREATE INDEX media_text_item ON media_text(item_id, source, pos);
CREATE VIRTUAL TABLE media_text_fts USING fts5(
  text, content='media_text', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
-- + the three standard external-content triggers (insert/delete/update) keeping the FTS in step.

CREATE TABLE media_text_vectors (           -- query/vocabulary text → vector cache
  model TEXT NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL, used_at INTEGER NOT NULL,
  PRIMARY KEY (model, text)
);
```
- **Size:** about 1.5 KB per vector. 10,000 photos plus 500 videos × 16 frames is about 27 MB, plus text (a 1-hour transcript is ≈ 50 KB).
- **Settings key `search`:** `{ enabled, paused, readText, speech, speechMaxMin: 60, skip: [rel path] }`. Everything defaults to on, and indexing starts the moment the pack's required components are present.
- **Bookkeeping:**
  - `media_items.path` follows Library `Rename` (one transaction);
  - Trash and Forget delete the row;
  - query vectors keep the last 500 queries.
- **Wave 0 checks** that `modernc.org/sqlite` has FTS5 enabled (it's compiled in upstream). If it isn't, it falls back to a `LIKE` scan over `media_text` with the same API, and the fallback goes in DECISIONS.

---

## 3. Architecture

### 3.1 Files
```
core/search.go                     types + small interfaces (frozen in Wave 0, §3.7)
core/mediaindex/                   the index (no Wails, no modules)
  index.go        Index: Open/Close, Enqueue, Query, Similar, Things, Labels, SetUserLabel, Texts, PutText, Status
  vectors.go      fp16 codec, in-memory matrix, dot products (par over 4096-row chunks)
  textsearch.go   FTS query building (terms, prefixes, "phrases"), snippets, bm25 → score
  scan.go         library + project walkers, skip rules, reconcile
  labels.go       vocabulary load, label scoring, text gate, strength cut-offs
  scheduler.go    idle detection → batch jobs (pictures/text first, speech last); pause; events
core/imaging/dhash.go              64-bit dHash (moved from modules/organize, exported)
core/doctext/                      pure-Go text extraction: txt/md/csv/json, srt/vtt/lrc/ass, html, docx/pptx/xlsx, odt/odp/ods, epub
core/store/mediaindex.go
core/store/migrations/0011_media_index.sql
modules/mediaindex/                hidden Quiet job modules "media-index" and "media-speech"; the step module
  module.go       Descriptors, Run = one batch
  prepare.go      image → 224 px JPEG; video frames (FFmpeg); PDF pages + text layer (core/pdfium)
  ocr.go          OCR of gated pictures via the engine's ocr.image
  speech.go       transcript reuse (lineage) or transcribe.run
  models.go       pinned SigLIP 2 files, ModelProvider ("search-default")
  vocabulary.tsv  frozen label vocabulary (§3.4)
  pipeline.go     the "Keep files that show…" step (core.Chainable)
sidecar/toolbox_sidecar/handlers/search.py   search.prefetch, search.embed_images, search.embed_text
api/search.go                      SearchService (Wails)
frontend/src/state/search.ts
frontend/src/views/library/        results merge, snippets, Things view, label chips, text panel, Find similar, status line
frontend/src/views/SettingsSearch.tsx
frontend/src/pipelines/steps/search.tsx
```

### 3.2 Finding and scheduling work
- **At start** (in main.go's deferred chores, 60 s after the window): reconcile the library and projects. This is a stat walk only:
  - no row → new;
  - `size`/`mod_ms` changed → `pending`, with its text, vectors and auto labels replaced when redone (user/hidden labels kept);
  - file gone → row deleted.
- **Live:**
  - `library:added` → enqueue;
  - project save → enqueue its thumb;
  - Rename / Trash / Forget → update or delete;
  - Caption Writer saves → `PutText(source 'caption')` (§3.7).
- **Scheduler:**
  - Submits one batch job **only when no other non-quiet job is queued or running**, indexing is enabled and not paused, and the Smart search pack's required components are installed.
  - It re-checks on every `Jobs.Observe` change and every 15 s.
  - Queue order:
    1. `media-index` batches (≤ 32 files, newest first): pictures + text;
    2. once none are pending, `media-speech` jobs (one file each, shortest first).
  - A user job submitted mid-batch waits at most one batch (≈ 10–20 s; a speech job is cancelled and requeued if a user job waits > 20 s).
- **Model change:** a new pinned vision model id marks every row `pending`. Old vectors are skipped in scoring until each row is redone.

### 3.3 Pictures (`media-index` job, inside its TempDir)
1. **Prepare**, with `core/par` (6 at a time):
   - **Image:** `imaging.ToReadable` → `imaging.Orient` → short side 224 → JPEG q90. A second ≤ 1600 px copy is kept for OCR if the gate passes.
   - **GIF/WebP:** the first frame and the middle frame.
   - **Video:**
     - probe the duration;
     - take frames at `max(2 s, duration/16)` steps, at most 16, with FFmpeg run in the TempDir (`-/filter_complex` file);
     - drop a frame within 6 bits (dHash) of the previous kept one;
     - keep ≤ 1600 px versions for OCR.
   - **PDF:** pages 1–4 at 224 px through `core/pdfium`. The text layer of every page (≤ 500) comes from `FPDFText`. Pages with < 20 characters of text get rendered at 1600 px for OCR (≤ 50 pages).
   - **Documents:** `core/doctext.Extract(path, limit 2 MB)` → chunks with `pos` (page/slide/sheet index where the format has one). No engine is needed.
2. **Embed:** one `search.embed_images` call with every prepared 224 px picture → float16 vectors.
3. **Labels and the text gate** (Go, §3.4).
4. **OCR** (when "Read text" is on): `ocr.image` on each gated picture (1600 px copy), and on PDF pages without a text layer. Lines are joined in reading order and chunked.
5. **Store:** one write transaction per batch (vectors, auto labels, text chunks, `state = done`, `model`, `indexed_at`).
6. **Failures:**
   - prepare error → `failed` with the reason, retried once at the next start;
   - an engine crash → the batch is retried once item by item; an item that crashes twice → `skipped`.
7. **Events:** `search:status` (throttled to 2/s), `search:indexed {paths}`.

### 3.4 Labels, the text gate and strengths
- **Vocabulary** (`modules/mediaindex/vocabulary.tsv`, embedded):
  - columns `id`, `category`, `display`, `prompts` (`|`-separated), `parent`, `threshold` (optional);
  - about 1,500 everyday concepts in the eight categories;
  - **no identity labels**: no names, ethnicity, gender or age.
  - A child label adds its parent (`apple` → `fruit` → `food`).
- **Score:** `p = sigmoid(scale · (img · text) + bias)`, using the model's pinned `scale`/`bias`; a label's text vector is the mean of its prompts, re-normalised.
  - A label is kept at `p ≥ threshold` (default from the Wave 0 calibration).
  - An item keeps ≤ 8 labels (+ parents). Videos and PDFs take the max over frames/pages and remember `pos`.
  - Changing the vocabulary recomputes labels from stored vectors, with no re-embedding.
- **Text gate:** OCR runs on a picture when the max `p` over the gate prompts is at least `textGate`. The gate prompts are "a screenshot", "a document", "a page of text", "a receipt", "a sign with writing", "a poster", "a presentation slide", "handwriting", "a chart", "a menu", "a label with text" and "a whiteboard". Wave 0 calibrates `textGate` so that ≥ 95% of the sample pictures with readable text pass.
- **Concept strengths:** Strong `p ≥ 0.3`, Good `p ≥ 0.1`, Maybe `p ≥ 0.03`, calibrated in Wave 0 (constants in `labels.go`, numbers in DECISIONS). Below Maybe nothing shows, so a query for something you don't have gives no concept results.

### 3.5 Speech (`media-speech` job, one file)
- **Eligible:** videos with an audio stream, and audio files. "Listen to speech" must be on. Files are ≤ `speechMaxMin` minutes; longer files are `skipped` ("Longer than 60 min · Transcribe now" in the failures list and the detail panel; the user action ignores the cap).
- **Reuse first.** If a library output whose lineage input is this file is a transcript (`.srt`/`.vtt`/`.json` from `transcribe` or `subtitles`), it's parsed and stored as source `subs` with timestamps. No engine is needed.
- **Otherwise:** `transcribe.run` with Whisper small (the `whisper-default` component), language auto, VAD on, word timestamps off, and the existing handler's options. Segments are stored as chunks of ≤ 30 s with `pos`/`end_pos`.
  - If VAD finds < 5% speech: `nospeech`.
  - **Music:** if the file's kind is audio and it has a library lineage from `stems`/`bpm-key`/`lyric-video`, or VAD says it's mostly music, the transcript is still stored. Lyrics are searchable, and that's useful.
- **Cancellable:** a user job waiting > 20 s cancels the speech job (`$cancel`), and it requeues with no penalty.

### 3.6 Query and ranking (`core/mediaindex.Query`)
1. **Labels:** the chip row lists vocabulary/user labels whose display starts with the query (≤ 8). Exact label matches are hits with `Strength = "label"` and score 1.
2. **Text:** FTS5 `MATCH` built from the query.
   - Words become prefix terms joined by AND; `"quoted phrases"` stay phrases; FTS operators typed by the user are escaped.
   - For each item, the best chunk wins. Its snippet comes from `snippet(media_text_fts, 0, '\u0002', '\u0003', '…', 12)`, and the UI bolds between the markers.
   - Score: every term matched in one chunk → **Strong** (0.35 + 0.1 · normalised bm25); terms spread across chunks → **Good** (0.15 + …).
3. **Concept:** the text vector (cache or `search.embed_text`) · every current vector; an item scores the max over its vectors → strength by §3.4.
4. **Merge:** label hits, then one list by score (an item with both text and concept hits takes the max and shows both icons), then name-only matches. Filters are applied after scoring, via `outputs` (library) or `media_items`.
5. **Warm-up:** if the text vector isn't cached, `Query` returns everything else at once with `Warming: true`, and emits `search:ready {text}` when the vector is in. The UI asks again.
- **In-memory matrix:** loaded lazily on the first concept query, kept current on writes, dropped after 10 idle minutes, capped at 512 MB. Above that it streams from SQLite in chunks, and the status says "Large index".

### 3.7 Go contracts (frozen in Wave 0)
```go
// core/search.go
type SearchQuery struct {
    Text       string       `json:"text"`
    Labels     []string     `json:"labels"`     // all must match (auto or user, not hidden)
    Similar    string       `json:"similar"`    // path
    SimilarPos int64        `json:"similarPos"`
    Filter     LibraryQuery `json:"filter"`     // kinds, module, since/until, folder (Search/Sort/Cursor ignored)
    Limit      int          `json:"limit"`      // default 200, max 500
}
type SearchHit struct {
    Path      string     `json:"path"`
    Source    string     `json:"source"`    // library | project
    ProjectID string     `json:"projectId"`
    Output    *Output    `json:"output"`
    Kind      OutputKind `json:"kind"`
    Score     float64    `json:"score"`
    Strength  string     `json:"strength"`  // strong | good | maybe | label | name
    Via       []string   `json:"via"`       // "label", "concept", "ocr", "pdf", "doc", "speech", "subs", "caption", "name"
    Pos       int64      `json:"pos"`       // -1, ms, or page
    Snippet   string     `json:"snippet"`   // \u0002…\u0003 around matched words; "" when not a text hit
    Moments   []int64    `json:"moments"`   // ≤ 5 other matching positions
}
type SearchPage struct {
    Hits    []SearchHit  `json:"hits"`
    Labels  []LabelCount `json:"labels"`
    Concept bool         `json:"concept"`   // concept scoring ran
    Warming bool         `json:"warming"`
}
type LabelCount   struct { Label, Display, Category string; Count int; User bool; Cover string }
type MediaLabel   struct { Label, Display, Source string; Score float64; Pos int64 }
type MediaText    struct { Source string; Pos, EndPos int64; Text string }
type SearchStatus struct {
    Installed, Enabled, Paused, Waiting bool
    Total, Done, Pending, Failed, Skipped int
    SpeechPending, SpeechDone int
    Stage, Current, Model string; IndexBytes int64; LastError string
}
type SearchFailure struct { Path, Reason, State, Stage string; Attempts int; At int64 }

// Small seams other modules use (implemented by core/mediaindex; nil-safe no-ops when Smart search is absent).
type MediaTextSink interface { PutText(path, source string, chunks []MediaText) error } // Caption Writer → index
type MediaHints    interface { Hints(path string) (labels []string, text string, ok bool) } // index → Caption Writer
```
`api/search.go`, `SearchService`:
```go
Status() core.SearchStatus
Query(q core.SearchQuery) (core.SearchPage, error)
Things() ([]core.LabelCount, error)
Labels(path string) ([]core.MediaLabel, error)
SetLabel(path, label string, on bool) error
Texts(path string) ([]core.MediaText, error)
ReadAgain(path string) error                 // re-OCR / re-transcribe (ignores the speech cap)
SaveText(path string, format string) (string, error) // "txt" | "srt" → Save dialog; returns the saved path
Failures(limit int) ([]core.SearchFailure, error); Retry(paths []string) error
SetEnabled(on bool) error; SetPaused(on bool) error; Rescan() error; Rebuild() error; DeleteIndex() error
SetOptions(readText, speech bool, speechMaxMin int) error; SetSkip(rels []string) error
Warm()
```

### 3.8 Models and the pack
- **Vision:** SigLIP 2 ViT-B/16, 224 px (`google/siglip2-base-patch16-224`, Apache-2.0, trained on WebLI). It comes as split visual/textual ONNX files + `tokenizer.json` from `immich-app/ViT-B-16-SigLIP2__webli`, stored in `<models>/search/siglip2-b16/`.
  - **Wave 0 spike:** confirm the file list, URLs, sha256, sizes, dim, `scale`/`bias` and the tokenizer length (64), then pin them in `models.go`.
  - If that export is unusable, Wave 0 exports once from the official checkpoint with Immich's open export script and hosts nothing. If even that's impossible, it uses `immich-app/ViT-B-32__openai` (MIT) and records why.
- **OCR:** the engine's existing RapidOCR (bundled models; other scripts as today).
- **Speech:** the existing `whisper-default` (Whisper small).
- **The pack `search`, "Smart search"** (icon `scan-eye`):
  - components `engine`, `ffmpeg`, `search-default` (new), `whisper-default`;
  - it unlocks `media-index` (Needs `engine`, `search-default`), `media-speech` (Needs `engine`, `whisper-default`, `ffmpeg`) and `search-filter` (Needs `engine`, `search-default`);
  - without FFmpeg, videos are skipped ("needs FFmpeg"). The packs test learns about hidden-module unlocks (DECISIONS).
- **Origin lines** (Settings → Search):
  - "SigLIP 2 by Google — trained on WebLI (web images with alt text) — Apache-2.0";
  - "RapidOCR (PP-OCR) — Apache-2.0";
  - "Whisper small by OpenAI — MIT. All run on this computer."

### 3.9 Pipeline step: "Keep files that show…" (`search-filter`)
- **Options:** `query` (template), `match` (`picture` | `text` | `both`, default `both`), `strength` (`strong`|`good`|`maybe`, default `good`), `invert`.
- **Behaviour:** files pass through untouched. They're scored from the index when current; otherwise they're prepared and embedded (+ OCR'd when `match` includes text) inside the job, and not added to the index unless they're in the library.
- **Outputs:** roles `kept` and `other`; variables `matched` (number) and `best` (text: the top label of the first kept file).
- `StepUI` in `pipelines/steps/search.tsx`, under "Organise".

---

# Part B — Caption Writer (`captions`)

## 4. Product

### 4.1 The tool
- **Sidebar:** "Caption Writer", category AI, icon `message-square-quote`. Tagline: "Alt text, captions, keywords and names for your photos and videos". The palette keywords are caption, alt text, describe, hashtags, rename by content, keywords, accessibility.
- **Input:** images (jpg, png, webp, heic, gif, bmp, tiff) and videos (mp4, mov, mkv, webm, m4v), ≤ 200 per batch. You can drop, paste, pick, pick from the Library (`pickFromLibrary`), use Send to, or use a hand-off.
- **Primary settings** (top level, per the minimal-surface rule):
  - **Write** (a preset that sets which fields are produced):

    | Preset | Fields |
    |---|---|
    | **For posting** (default) | caption, hashtags, alt text |
    | **Accessible** | alt text, long description |
    | **Catalogue** | title, description, keywords |
    | **Rename** | file name |
    | **Everything** | all fields |
  - **Context:** one text box ("Lisbon trip, May 2026. The dog is Max. Bakery is Manteigaria.") applied to the whole batch. Each file can add its own note in its card.
- **Advanced** (`ClickIn`, with a one-line summary such as "Warm · medium · English · 5 hashtags"):
  - **tone:** plain / warm / playful / professional / poetic;
  - **length:** short / medium / long;
  - **language:** Auto (= the app language, English) or any of 30 listed;
  - **emoji:** on/off;
  - **hashtags:** 0–15;
  - **name pattern:** `{name}`, `{date} {name}`, `{n} {name}`, kebab-case on/off;
  - **use Smart search hints** (labels + text found in the file, on when installed);
  - **include the words visible in the picture** (on);
  - the **model** (§5.2).
- **Results:** a card per file:
  - a thumbnail (a video shows its frame strip);
  - **editable fields**: alt text (with a live "118 / 125" counter that turns amber above 125), caption, hashtags (chips), title, description, keywords (chips), file name;
  - each field has Copy, and the card has **Regenerate** (a new seed; keeps your edits in other fields unless you choose "Regenerate all") and **"Note for this file…"**;
  - cards appear **one by one as they finish**, and the batch can be cancelled with what's done kept.
- **Batch actions** (a one-line bar):
  - **Save** writes `captions.json` + `captions.csv` into the batch folder (always, on every edit, debounced 1 s) and can export **.txt per file** or a single **.md**;
  - **Copy all** (a menu: captions, alt texts, CSV);
  - **Write into copies…** (§5.4);
  - **Rename copies…** (§5.4);
  - **Send to** on the batch's files, with Reveal / Open / Save a copy per result file through `FileActions`, as the kit requires.
- **Stands alone:**
  - the batch folder name and path show (`<library>/Captions/<batch name>/`);
  - Reveal, Open and Save a copy are visible on every written file;
  - **Past batches**: a list (newest first) of earlier batches. Opening one reloads its cards from `captions.json` so you can keep editing; deleting one moves its folder to the trash;
  - a completion toast fires when a batch finishes while the tool is hidden (`announceWhenDone`).
- **Never identifies people.** A person is "a woman in a red coat", "two children" or "a man on stage". Names come only from your context or a per-file note. The model never guesses age, ethnicity, health, religion, or who someone is. This sits in the system prompt and is checked by a test with a fixture reply.
- **Grounded:**
  - the prompt includes the Smart search labels and the OCR/transcript excerpt when available (≤ 1,500 chars);
  - for videos it includes 6 frames + the transcript excerpt;
  - the model is told to describe only what's visible or given, and to say "a sign" rather than invent unreadable text.
- **Embedded use:**
  - **Post Builder** gets "Write with Caption Writer" next to its caption box (`<ToolClickIn host="post-builder" module="captions" …>`). It passes the post's slide files with the preset "For posting" and context from the post. **Use** returns the caption + hashtags into the box (also from a popped-out window).
  - **The Library detail panel** gets "Write caption…" on images and videos (it opens Caption Writer with the file).
- **Smart search:** every saved caption, alt text, description, keywords and title is `PutText` into the index (source `caption`), so search finds files by their captions. User edits update it.

### 4.2 Field rules (in the prompt, then checked in Go)
| Field | Rule (Go clamps/repairs after the model) |
|---|---|
| alt text | ≤ 125 chars preferred; hard cap 250; no "image of"/"picture of" opener; ends without hashtags/emoji |
| description | 2–5 sentences (long: up to 8), plain text |
| caption | tone/length/emoji as set; never includes hashtags (they're separate); ≤ 2,200 chars (Instagram's limit from `modules/posts/limits.go`) |
| hashtags | exactly N (or fewer if the model can't), `#` + letters/digits/underscore, de-duplicated, no banned/generic spam list (`#love #instagood …` filtered) |
| title | ≤ 70 chars, no trailing period |
| keywords | 5–25, lowercase, singular, de-duplicated, no identity terms |
| file name | ≤ 60 chars, sanitised with `core.SanitizeFileName`, the pattern applied, extension kept, unique in the target folder |

## 5. Architecture

### 5.1 Files
```
core/textgen.go                    + CompletionRequest.Images, .Model; TextGenerator.Vision() (frozen in Wave 0)
modules/chat/                      vision support: catalog mmproj files, --mmproj, image content parts, model switching
modules/captions/
  options.go      Options, Preset, Tone, Length, NamePattern, DefaultOptions()
  module.go       Descriptor, Validate, Run (one batch), Register
  prompt.go       system/user prompt building, JSON schema per preset
  fields.go       §4.2 clamps and repairs (pure, table-tested)
  frames.go       video frames (6, FFmpeg in TempDir), images → ≤ 896 px JPEG (oriented, HEIC)
  batch.go        captions.json/.csv read/write, past batches, PutText
  metadata.go     write into copies (ExifTool / FFmpeg), rename copies
  pipeline.go     core.Chainable
  service.go      CaptionService
frontend/src/tools/captions/       CaptionsView, cards, batch bar, past batches, advanced ClickIn
frontend/src/pipelines/steps/captions.tsx
frontend/src/tools/posts/…         the "Write with Caption Writer" ToolClickIn (one component + its mount line)
```

### 5.2 The vision model (through Local Chat's engine)
- **The chat engine learns to see.**
  - Catalog entries gain `MMProj {File, Bytes, SHA256}` and `Vision bool`.
  - When the loaded model has one, `llama-server` gets `--mmproj <file>`, and messages carry OpenAI-style `image_url` parts with base64 JPEG `data:` URLs (≤ 896 px, built in Go; no paths are sent).
  - Ollama models are used when they report vision.
  - Local Chat's own UI isn't changed this phase (Later: image drops in chat).
- **`core.TextGenerator` additions:**
  - `Vision() (model string, err error)` returns the model Caption Writer will use, or `CodeDependencyMissing` ("Install the Captions pack").
  - `CompletionRequest.Images []string` (local paths, read and encoded by the chat module) and `CompletionRequest.Model string` ("" = the chat model; Caption Writer passes the vision model).
- **Choosing the model:**
  - The user's chat model is used when it can see.
  - Otherwise the **vision-default** model is used. Switching restarts `llama-server` with that model once for the whole batch. It never happens while an interactive chat reply is streaming, and the job waits with "Waiting for Local Chat". Local Chat shows "Caption Writer is using <model>" while the batch holds the engine, and it reloads its own model on its next message.
- **vision-default** is picked in the **Wave 0 spike** from multimodal GGUFs that llama.cpp `b11938` loads with an mmproj, all Apache-2.0:
  - Qwen3.5 2B (already in the catalog) and Gemma 4 E4B (in the catalog);
  - a Qwen3.5 ≈ 4B if it's published;
  - **Qwen3-VL 4B Instruct** as the fallback.

  The criteria are caption quality on 20 photos + 4 videos from the sandbox library (a scored rubric: specificity, no hallucinated text, follows the JSON schema), **≤ 8 s per image** warm on this PC, and **≤ 6 GB RSS**. The pick, scores and timings go in DECISIONS. Files are pinned (sha256 from the HF LFS oid) in the chat catalog.
- **The pack `captions`, "Caption Writer"** (icon `message-square-quote`):
  - components `chat-engine`, `vision-default`, `exiftool`, `ffmpeg`;
  - it unlocks `captions` with Needs `chat-engine` + `vision-default`;
  - without ExifTool, "Write into copies" is disabled with that reason; without FFmpeg, videos are refused with a reason.

### 5.3 The job
- **One job per batch**, with `Descriptor.Interactive` false and `OutputSubdir` `Captions`. The batch folder is `<library>/Captions/<batch name> <yyyy-mm-dd>/`, where the batch name is the context's first words or the first file's folder name.
- **For each file, in input order, one at a time** (the engine has one generation slot):
  1. prepare the pictures (`frames.go`);
  2. get hints (`MediaHints`, when on);
  3. call `Complete` with a JSON schema for the preset's fields (temperature 0.4 + a per-file seed; Regenerate uses a new seed);
  4. parse, then apply the `fields.go` repairs;
  5. append to `captions.json` and emit `captions:item {jobId, index, item}` (`core.Emitter`);
  6. `job.Progress`.
- **A bad reply** (bad JSON after one retry with "Reply only with JSON") marks that file `failed` with the reason in its card, and the batch continues.
- **The result:** `job.SetResult({batchDir, done, failed})` (small). `captions.json` is the full record, registered with `job.OutputFrom(batch file, every input)`, as is `captions.csv`.
- **Regenerate one** is its own small job (`Interactive`) that updates the batch file.
- **Batch JSON:** `{version:1, name, created, options, items:[{input, fields:{alt,description,caption,hashtags[],title,keywords[],name}, edited:{field:true}, state, reason, seed}]}`. Edits are saved by `CaptionService.SaveBatch(dir, batch)` (validated, atomic write).

### 5.4 Write into copies, rename copies
- **Write into copies…**
  - **Images:** the copy goes to `<batch>/With captions/<original name>`. ExifTool (`-overwrite_original` only on that copy, never the input) writes:
    - `XMP-iptcCore:AltTextAccessibility` = alt;
    - `XMP-iptcCore:ExtDescrAccessibility` = description;
    - `XMP-dc:Description` and `EXIF:ImageDescription` and `IPTC:Caption-Abstract` = caption or description (a choice in the dialog);
    - `XMP-dc:Title` = title;
    - `XMP-dc:Subject` + `IPTC:Keywords` = keywords.
  - **Videos:** FFmpeg stream copy with `-metadata title= -metadata description= -metadata comment= -metadata keywords=` (mp4/mov/mkv). For webm, only title.
  - The dialog lists the fields with checkboxes and a "Keep location data" toggle (default **off**, which strips GPS on the copies, as Post Builder's export does).
- **Rename copies…** copies files into `<batch>/Renamed/` with the generated names (the pattern applied, unique). It shows a before → after preview first. The originals are never renamed.
- **Both** are jobs of the `captions` module (action option `write` / `rename`), outputs registered with lineage, and each ends with a `LastExport`-style result bar (Reveal, Open folder, Save a copy).

### 5.5 Pipeline step "Write captions" (`captions`)
- **Options:** the same as the tool (preset, context with `{vars}` templates, tone, length, language, hashtags, name pattern), plus `then`: `nothing` | `writeCopies` | `renameCopies`.
- **Outputs:**
  - files: role `captioned` (copies with metadata or renamed copies, when `then` isn't `nothing`) and `table` (`captions.csv`);
  - variables (per file, for the next steps): `alt`, `caption`, `hashtags`, `title`, `description`, `keywords`, `name` (text).

  Example: watch folder → Write captions (Rename) → Rename built-in with `{name}`.
- **Waiting:** without the vision model it waits with `ErrWaiting("Install the Caption Writer pack")`.

---

## 6. Errors and limits
- **Smart search:**
  - **Engine or model missing:** search works on names, user labels and any stored text. The gate line names the pack.
  - **Engine busy or crashed during a query:** the instant results still show, plus "Couldn't search pictures right now · Try again".
  - **An unreadable file:** `failed` with the reason, listed with Retry.
  - **Index DB error:** indexing stops ("Indexing stopped: <reason>"), and search falls back to names. The app is unaffected.
  - **FTS syntax** typed by the user is escaped and never errors.
- **Caption Writer:**
  - **No vision model:** a `DepsGate` with the Captions pack button. If the chat model can see, the tool works without the pack's model.
  - **Local Chat busy:** "Waiting for Local Chat to finish its reply".
  - **Out of memory loading the model:** "Not enough memory for <model> — close other apps or pick Qwen3.5 2B in Advanced".
  - **A file that can't be read:** that card says why, and the rest continue.
  - **Write into copies:** ExifTool errors are reported per file, never fatal for the batch. Inputs are never touched (a test hashes them before and after).

## 7. Tests
- **Go:**
  - `core/store`: migration 0011 from a 0010 fixture, cascades, FTS triggers in step on insert/update/delete, rename/trash keeping `media_items` in step.
  - `core/mediaindex`:
    - the fp16 codec;
    - top-k scoring against a naive reference;
    - labels, parents, and `hidden` that survives re-index;
    - the text gate;
    - FTS query building (a table: words, prefixes, quotes, typed operators escaped, non-Latin text);
    - snippet markers;
    - merge order and de-duplication;
    - skip rules (hidden, symlink, support dir, clipboard, vault, skip-list);
    - reconcile;
    - the scheduler (idle-only, pause, speech after pictures, cancel-on-wait);
    - a model change;
    - the 512 MB fallback.
  - `core/doctext`: a fixture per format (generated in the test, never third-party files), the 2 MB cap and positions.
  - `modules/mediaindex`:
    - prepare (orientation, HEIC via a fake converter, GIF frames, video frames + dHash dedupe on a generated video, PDF text layer + OCR fallback pages, an encrypted PDF);
    - OCR and speech with a fake `Caller`;
    - transcript reuse through lineage;
    - the `Chainable`.
  - `modules/chat`: mmproj args, image parts encoding (≤ 896 px, no paths sent), model switching that waits for interactive replies, `Vision()`.
  - `modules/captions`:
    - `fields.go` repairs (a table);
    - prompt building per preset (golden strings) with the no-identification rule present;
    - the JSON schema per preset;
    - `Run` with a fake `TextGenerator` (order, a failed item continues, cancel keeps what's done, `captions.json`/`.csv`);
    - write-into-copies with a fake ExifTool via the re-exec helper (args, inputs unchanged);
    - rename uniqueness;
    - the `Chainable`;
    - `PutText` called.
  - Root: the packs test (`search`, `captions`), `pipeline_proof_test` (`search-filter`, `captions`), `TestEveryToolIsAPipelineStep` (`captions`), and the vocabulary test (unique ids, valid categories, parents exist, banned identity words absent).
- **Python:**
  - `search.*` against a tiny generated ONNX model + a toy `tokenizer.json` (padding, batch order, cancel between batches);
  - slow real-model tests (`TOOLBOX_SLOW=1`): "a photo of an apple" scores higher on a generated red apple than on a blue square.
- **Frontend (vitest):**
  - Library:
    - the results merge and no-jump insertion;
    - snippet bolding (markers, never `innerHTML`);
    - the source icons;
    - the chips;
    - the Things view;
    - the text panel (timestamps seek, Copy, Save);
    - Find similar;
    - the status line in every state and the gate;
  - `SettingsSearch`;
  - Caption Writer:
    - cards stream in from `captions:item`;
    - field editing with debounced save;
    - the alt counter;
    - Regenerate;
    - the batch bar;
    - past batches;
    - the gate;
    - embedded Use from Post Builder;
  - the step UIs and their params labels;
  - 960 × 600 via the media-query mocks.

## 8. Acceptance (on the Windows PC, a real build, sandbox env)
1. **Indexing:**
   - Install **Smart search** from the Library's prompt. Indexing starts by itself, the status counts up, and the app stays responsive.
   - A Converter job submitted mid-index starts within one batch (≤ 20 s).
   - Start-up time is unchanged (±5%).
2. **The sample set.** Wave 0 assembles it in the sandbox library from `.dev/` research inputs plus generated files: an apple, a dog, a receipt photo with "4471", a code screenshot, a sunset, a 2-min video with a dog after 0:20 and someone saying "quarterly budget" at 1:10, a scanned 3-page PDF (no text layer) with "invoice" on p. 2, a `.docx` with "Lisbon", and a voice memo `.m4a`.
   - `apple`: the apple photo is in the top 3, with the chip "apple".
   - `dog`: the photo and the video (the moment after 0:20; clicking plays from there).
   - `4471`: the receipt, with the snippet bolded. `invoice`: the PDF, "p. 2".
   - `quarterly budget`: the video at ≈ 1:10 (the speech icon); the transcript in the detail panel seeks on click, and Save as .srt works.
   - `Lisbon`: the docx. `pomme`: the apple. `giraffe`: no concept results, and "No files match 'giraffe'".
3. **Labels:** hide "fruit" on the apple and Rebuild: it stays hidden. Add the label "lunch" and search `lunch`: found.
4. **Things and similar:** the Things view shows Food & drink → apple. Find similar on the dog photo puts a dog video frame in the top 5.
5. **Offline:** after install, with outbound blocked, indexing, search and captioning all work.
6. **Privacy:** an apple picture copied into clipboard history never appears in search.
7. **Caption Writer:**
   - install the Captions pack;
   - run 10 sample photos + the dog video with "For posting", context "Lisbon trip; the dog is Max";
   - every caption is specific, mentions Max only for the dog, never names other people, and has 5 hashtags; alt texts are ≤ 125 chars;
   - edit one, restart the app, and the edit is still there in Past batches;
   - Write into copies: ExifTool reads back the alt text and description from the copies, and the inputs' hashes are unchanged;
   - Rename copies gives readable unique names;
   - searching a word that's only in a caption finds the photo.
8. **Post Builder:** "Write with Caption Writer" → Use fills its caption box.
9. **Pipelines:**
   - folder watch → "Keep files that show… receipt" → Copy to `Receipts/` copies only the receipt;
   - folder → Write captions (Rename) → Rename `{name}` gives named copies.
10. **Screens:** 1180 × 720 and 960 × 600, light and dark (`.dev/p20-qa/`).

---

## 9. Decisions (your answers to rev 1, plus mine; no open questions)
- **Model:** SigLIP 2 ViT-B/16 (the better model), about 1.5 GB.
- **Indexing** starts automatically on install.
- **Library only** (plus project thumbnails, which the Library already shows under Places). Folders outside the library are Later.
- **Text inside files** is in this phase: OCR, PDF/document text and speech, all on by default and each one can be turned off. Speech is capped at 60 min per file automatically.
- **The new captions tool is Caption Writer.** I chose it because nothing in Toolbox writes words *about* pictures. It turns the new vision capability into something you keep (alt text, captions, names, embedded metadata), and it composes with Post Builder, pipelines and Smart search. Rejected alternatives:
  - **TikTok-style animated captions:** Subtitles, Lyric Video and Edit Studio already burn in styled text;
  - **subtitle re-sync:** narrow;
  - **a caption-file fixer:** mostly covered by Subtitles' editor.
- **The vision LLM** goes through Local Chat's existing engine (one loopback llama-server, no new listener). The pick is measured in Wave 0.
- **Faces/people:** not in this phase. Neither model identifies anyone.

---

## 10. Work packages

### Wave 0 — foundation (architect, sequential, on main)
1. CLAUDE.md "Smart search and Caption Writer (Phase 20)" section; DECISIONS; ROADMAP row.
2. **Spikes** (DECISIONS):
   - (a) SigLIP 2 files, pins, `scale`/`bias`, embedding speed and RSS;
   - (b) FTS5 in modernc;
   - (c) the vision LLM pick (§5.2) with timings and rubric scores;
   - (d) the OCR and Whisper speed on this PC (seconds per screenshot and per minute of speech) to set the batch sizes.
3. Migration 0011 + store stubs; `core/search.go`; the `core/textgen.go` additions; `core/mediaindex.Index` with stubs; `core/doctext` signature; `SearchService` and `CaptionService` stubs; module skeletons (`media-index`, `media-speech`, `search-filter`, `captions`) with Descriptors, Options, `StepDefaults`/`DescribeStep`; `handlers/search.py` stub; the packs and components; the chat catalog `MMProj`/`Vision` fields (pins from spike c); wiring in `main.go`; events (`search:*`, `captions:item`); icons (`scan-eye`, `message-square-quote`, `tags`); the stub `CaptionsView`, `SettingsSearch` and `StepUI`s + `paramDefs`; `shell/keywords.ts`.
4. Move the dHash to `core/imaging/dhash.go`.
5. The vocabulary format + ≈ 300 labels; the calibration harness (`go test -tags calibrate ./modules/mediaindex/`, `TOOLBOX_CALIBRATE_DIR` with `labels.csv` → precision/recall per threshold, plus text-gate recall); the acceptance sample set in `.dev/p20-qa/samples/` (generated or from existing research inputs).
6. Regenerate bindings and re-export from `lib/api.ts`. All checks green.

### Wave 1 — parallel builders

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **S1 Engine** | `search.prefetch/embed_images/embed_text`, tiny-model fixtures, slow tests; `ModelProvider` | `sidecar/toolbox_sidecar/handlers/search.py`, `sidecar/tests/test_search.py`, `sidecar/tests/fixtures/search/**`, `modules/mediaindex/models.go` | Wave 0 |
| **S2 Index core** | `core/mediaindex/**` (scan, reconcile, scheduler, vectors, labels, text gate, FTS query + snippets, merge), `core/store/mediaindex.go`, rename/trash/forget hooks, deferred-chores wiring | `core/mediaindex/**`, `core/store/mediaindex.go`, the hook lines in `api/library_actions.go` and `core/projectdocs` | Wave 0 |
| **S3 Extractors + jobs** | `media-index` and `media-speech` jobs: prepare, OCR, PDF text, speech + transcript reuse; `core/doctext` | `modules/mediaindex/{module,prepare,ocr,speech}.go` (+ tests), `core/doctext/**` | Wave 0 (fake `Caller`/index) |
| **S4 Search API** | `SearchService` | `api/search.go` (+ tests) | Wave 0 (`Index` interface faked) |
| **S5 Library + Settings UI** | results merge, snippets, chips, badges, Things, the detail panel (labels, text, similar, caption), status/gate, `SettingsSearch`, palette | `frontend/src/views/library/**`, `frontend/src/state/search.ts`, `frontend/src/state/library.ts` (search fields), `frontend/src/views/SettingsSearch.tsx` (+ css/tests) | Wave 0 |
| **S6 Search step** | `search-filter` | `modules/mediaindex/{pipeline,filter}.go` (+ tests), `frontend/src/pipelines/steps/search.tsx`, its `paramDefs` lines | Wave 0 |
| **V1 Vocabulary** | the full ≈ 1,500-label `vocabulary.tsv` + test | `modules/mediaindex/vocabulary.tsv`, `modules/mediaindex/vocabulary_test.go` | Wave 0 |
| **C1 Chat vision** | mmproj download/verify/remove with the model, `--mmproj`, image parts, `Vision()`, model switching + the Local Chat "in use" notice, Ollama vision | `modules/chat/**`, the Local Chat notice line in `frontend/src/tools/chat/**` | Wave 0 |
| **C2 Caption Writer backend** | `modules/captions/**` (job, prompts, fields, frames, batch files, metadata, rename, `Chainable`, service) | `modules/captions/**` | Wave 0 (fake `TextGenerator`) |
| **C3 Caption Writer UI** | `tools/captions/**`, the step UI, the Post Builder `ToolClickIn`, "Write caption…" in the Library detail panel (one action line, coordinated with S5 by a named slot S5 leaves: `DetailPanel` `extraActions`) | `frontend/src/tools/captions/**`, `frontend/src/pipelines/steps/captions.tsx`, `frontend/src/tools/posts/CaptionWriterClickIn.tsx` + its mount line | Wave 0 |

### Wave 2 — after Wave 1 merges
- **I1 Integration** (architect):
  - S1–S4 end to end with the real models;
  - calibration of the label thresholds, text gate and strengths on the sample set (DECISIONS);
  - C1–C3 with the real vision model;
  - the acceptance run §8;
  - start-up timing;
  - QA shots;
  - the CLAUDE.md final pass.

---

### Later
- Folders outside the library (read-only, opt-in per folder).
- Faces/people (a separate opt-in pack); places from GPS.
- Image drops in Local Chat (the engine can see after C1).
- "Memories" collections; near-duplicate finder from the stored vectors.
- GPU execution (DirectML/CoreML) for indexing.
- Search inside `pickFromLibrary` with the same box.
- Caption Writer: brand voice presets saved per name; captions for PDFs/slides.
