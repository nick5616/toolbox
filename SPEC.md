# Toolbox — Phase 8 Spec: Pipelines (chains of tools, run on a drop)

Status: **APPROVED 2026-10-31** (r1).
Date: 2026-10-31. Author: architect session (Opus).

Phases 1–7 are shipped; their specs are archived in `docs/specs/phase-{1..7}.md`, and every contract there still holds unless changed here. "P7 §x" etc. refer to those files. The intended model is in `docs/ROADMAP.md` ("Pipelines (Phase 8)"); this spec makes it concrete.

---

## 0. What exists and what this builds on

Surveyed on 2026-10-31 (every module's options, outputs, results and views).

### 0.1 The job system already does most of the work
- Every tool is a `core.Module`, and its work is a `Job` submitted through `Jobs.Submit(moduleID, inputs, optionsJSON)`.
  - Jobs have cancel, retry (same ID), logs, progress and Library outputs.
  - The job manager enforces the global and per-module concurrency limits.
- `Descriptor.Accepts` says what a tool reads (extensions, URLs, any).
- **Nothing declares what a tool makes.** Outputs are registered with `job.Output(path)` as they appear, and their kind comes from the extension (`core.KindForPath`). Data results (`ResultJSON`) are module-specific.
- Option decoding is strict (`DisallowUnknownFields`). stems, midi and transcribe don't fill in missing fields, so `{}` is invalid for them.
- `Submit` validates every input at once and splits per input only for `SplitInputs` modules. PDF Toolkit groups per input in its own service (`enqueue.go`), not in core.

### 0.2 Which tools can run unattended today

| Module (ID) | Unattended? | What blocks it, and the fix in this phase |
|---|---|---|
| Downloader `downloader` | yes (1 file, or N for a playlist) | — |
| Converter `converter` | yes | Images ignore `MaxHeight` → fixed (§6.3) |
| Video Trimmer `trimmer` | **no** | `Segments` are absolute times checked against one file → a step form with "whole / first / last / range" resolved at run time (§6.3) |
| Subtitles `subtitles` | only generate/extract | burn/embed take cues inline and the media as input → new action `auto` (§6.4) |
| Audio Cleanup `audio-cleanup` | yes (Preview off) | — |
| Lyric Video `lyric-video` | **no** | render needs `Lines` from a prior `lyrics` result → new action `auto` (§6.4) |
| Visualizer `visualizer` | **no** | render needs an `AnalysisKey` and a `ShowJSON` → new action `auto` (§6.4) |
| Redact `redact` | yes, with action `auto` | — |
| Stem Splitter `stems` | yes | — |
| BPM & Key `bpm-key` | yes (no files, data only) | — |
| Audio → MIDI `audio-to-midi` | yes | — |
| Transcribe `transcribe` | yes | The transcript text is only in the files |
| OCR `ocr` | yes | Encrypted PDFs are refused |
| PDF Toolkit `pdf` | partly | Passwords live only in an in-memory store; organize/ranges are per-document → asked at run start; organize excluded (§6.3) |
| Vault `vault` | only "add", only while unlocked | → the step waits for an unlock (§6.3) |
| Background Remover `bg-remover`, Upscaler `upscaler`, EXIF `exif` | yes (EXIF: strip, or a fixed edit) | Upscaler validates input size (fails the cell if too big) |
| Object Eraser `object-eraser` | **no** (a mask painted per photo) | manual steps only |
| Local Chat `llm-chat`, Clipboard `clipboard` | job-less | Chat is used through `core.TextGenerator` by a built-in step (§7) |
| Dev Utilities `dev-utils` | accepts nothing | not a step |

### 0.3 Things reused
- **`core.TextGenerator`** (Local Chat) for the built-in chat step. It has no chunking; the step chunks long text itself (§7.3).
- **`core.UniquePath`** for every new file name.
- **`useModuleOptions`**, the `options.ts` `DEFAULT_*`/`sanitize*` helpers of each tool, and the two self-contained option panels (Downloader's `OptionsPanel`, Redact's `OptionsPanel`) in the step editors.
- **`useUI().handOff`** to open a tool with files for a manual step, and the drop routing (`app:files-dropped` with a `targetId`).
- **The toast with an action** (`toast({action})`) for "needs you" notices.

---

## 1. Goals

1. **A Pipelines page** (top of the sidebar, under Recent):
   - make, edit, duplicate and delete pipelines;
   - start one from a **built-in template** (11, §10);
   - run one;
   - watch its runs.
2. **A pipeline is an ordered list of steps.** Each step is:
   - a **tool with its own options** (the tool's own fields, in a step editor);
   - or a **built-in step**: Rename files, Ask Local Chat, Make a table, Zip, Copy to folder, Check.
3. **Data flows between steps:**
   - **Fan-out:** a step that makes several files feeds the next step one file at a time.
   - **Filters:** "bass stem only", "videos only", "*.srt".
   - **Fan-in:** a "together" step gathers every file of the run (merge into one PDF, one CSV of receipts, one zip).
   - **Any earlier step:** a step can read from any earlier step, not only the previous one. That gives branching without a node graph.
4. **Data results become variables:**
   - `{bpm}`, `{key}`, `{title}`, `{transcript}`, `{text}` and the chat's own fields;
   - usable in file names, chat prompts, table columns, lyric titles and EXIF fields.
5. **"I'll do this step myself":**
   - the run pauses and opens that tool with the file loaded;
   - it picks up what you make there, and continues (on its own if you like).
   - A **Check** step pauses so you can look at the files and drop any you don't want.
6. **Triggers:**
   - the Run button;
   - drop files on a pipeline;
   - the global drop chooser;
   - Library → Send to;
   - the command palette;
   - an optional **watch folder**.
7. **Every step is an ordinary job.** It shows in the job tray with a pipeline chip, can be cancelled and retried (a retried job resumes its run), keeps its logs, and puts its files in the Library. In-between files can be cleaned up when a run finishes.

## 2. Non-goals (Phase 8)

- A **node-graph editor**, loops, conditions ("if BPM > 120"), or steps with two inputs. A step has one source, and branching comes from choosing an earlier step.
- **Scheduled runs** (cron) and runs while Toolbox is closed. Watch folders work while Toolbox runs, including from the tray.
- **OS notifications.** The tray menu, a sidebar badge and toasts say when a run needs you (§11.7).
- **Markdown → PDF.** That is Phase 9 (Pandoc + Typst). The Lecture template writes Markdown for now; Phase 9 adds the PDF step.
- **Sharing or importing pipelines** as files.
- **Per-step options in manual steps.** A manual step uses the tool's own UI and its last-used options.
- Object Eraser, PDF organize, and hand-edited cues/lyrics/boxes as **automatic** steps. They stay available as manual steps.

---

## 3. Architecture

```
                        ┌──────────────────────── Go ─────────────────────────────┐
 Run / drop / Send to → │ modules/pipelines  Service (bound) ─┐                   │
 palette / watch folder │   built-in steps: rename, chat,     │                   │
                        │   table, zip, copy (a job module)   ▼                   │
                        │ core/pipeline  Runner ──────────▶ core.Jobs.SubmitFor   │
                        │   event loop · items × steps       (tagged run/step)    │
                        │   adapters: core.Chainable ◀── modules/<id>/pipeline.go │
                        │   Observe(job) ◀──────────────── core.Jobs (every job)  │
                        │   watch folders (poll 5 s)                              │
                        │ core/store  pipelines · pipeline_runs · watch_seen      │
                        └───────────────┬─────────────────────────────────────────┘
                     pipelines:changed  │ pipelines:run (throttled)
                        ┌───────────────▼─────────── webview ─────────────────────┐
                        │ tools/pipelines: list, editor, step editors, runs       │
                        │ shell: "needs you" banner over tool views, job chips,   │
                        │        drop chooser + Library Send to + palette         │
                        └─────────────────────────────────────────────────────────┘
```

- **A run isn't a job.** It never holds a concurrency slot (a parent job waiting on children would deadlock at concurrency 1). The **Runner** is a single event loop in Go. It submits ordinary jobs tagged with the run and step IDs, and reacts to their updates through a new `Jobs.Observe` hook.
- **Tools describe themselves as steps** through an optional interface, `core.Chainable`, implemented in a new `pipeline.go` in each module. It covers:
  - what the step accepts and makes, including output **roles** like "bass";
  - how to turn files into job submissions;
  - how to read the outputs and variables back from a finished job.
- **Built-in steps** (rename, chat, table, zip, copy) are actions of a new job module, `pipelines`, so they are ordinary jobs too. The Check step is handled by the Runner alone.
- **No new listener, no new binary, no new dependency, no new model.**

---

## 4. The model

### 4.1 Terms
- **Pipeline:** a name plus 1–30 **steps** and an optional watch folder.
- **Step:**
  - a **type**: a tool (module ID) or a built-in (`pipelines.rename` … `pipelines.check`);
  - its **options** (JSON in that type's step-options shape, §6);
  - a **source** (`From`): the run's inputs, an earlier step, or nothing;
  - a **filter**;
  - three flags: **Manual** ("I'll do this myself"), **AutoContinue** and **Keep** ("keep its files in the Library").
- **Run:** one execution of a pipeline on a list of inputs (files or links). It holds a snapshot of the steps, so editing the pipeline never changes a run in progress.
- **Item:** one input of a run. Each item moves through the steps on its own; that is the fan-out.
- **Cell:** one item at one step. It has a status, its jobs, the files it was given, the files it made, and the variables it produced.
- **Together step:** a step that runs once over every item, e.g. merge PDFs, table, zip. It is decided by the step type and its options (`StepInfo.Together`).
- **Merged item:** created by the first together step. It gathers the items that reached it healthy, and the run continues on it from that step.

### 4.2 Rules
1. **Steps run in order within an item.** A cell is ready when every earlier cell of its item is finished. That keeps variables deterministic: step 4 sees step 3's `{bpm}`. Throughput comes from several items moving at once.
2. **Input files for a cell:**
   - `From: "input"`: the item's own input. A link becomes a `RunFile` with kind `other` and the URL as both path and name.
   - `From: "<step id>"`: that step's cell's `Files`. For a merged item, a step before the merge means the union, in item order, of the merged items' cells.
   - `From: "none"`: no files, only for step types with `NoFiles` (chat, table).
3. **Filtering.** The filter applies first, then the step's `Accepts`. Files dropped by either are noted in the cell message ("2 files skipped: not images").
   - Zero files left (and not `NoFiles`) → the cell is **skipped** ("Nothing for this step"). That isn't a failure.
   - A later cell that reads only from a skipped cell gets no files and skips too.
4. **A failed or cancelled cell stops its item.** Every later cell becomes **blocked**. Retrying the job (or the run) un-blocks them.
5. **Together steps:**
   - The step runs when every non-merged item has finished all its earlier cells.
   - Healthy items (no failed, cancelled or blocked cells) are merged; the others are left out.
   - Zero healthy items → the together cell is blocked for every item.
   - An item that finishes later, after a retry, stops at the together step with `skipped` ("Finished after the files were gathered").
6. **Manual steps** pause the item: the cell is `waiting` and the run shows "Needs you" (§8.4).
7. **Check steps** pause the item until you keep some or all of its files (§8.5).
8. **Variables accumulate per item**, in step order, and later values win. A merged item starts with only the run's built-in variables. A together step sees every merged item's variables (so a table can have one row per item).

### 4.3 Variables
- Syntax: `{name}`. Names match `[a-z][a-z0-9_]{0,31}`. `{{` and `}}` are literal braces.
- **Built-ins** (always defined):

| Variable | Value |
|---|---|
| `{item}` | the item's label without its extension (the downloaded title for links) |
| `{name}` | per file: the current file's name without extension; elsewhere, same as `{item}` |
| `{ext}` | per file: its extension, without the dot |
| `{role}` | per file: its role label, e.g. "Bass" ("" if none) |
| `{n}` | the item's number, from 1 |
| `{date}` | the run's start date, `YYYY-MM-DD` |
| `{time}` | the run's start time, `HH-MM` |
| `{pipeline}` | the pipeline's name |

- **Step variables:**

| Step | Variables |
|---|---|
| downloader | `title` (the media title), `url` |
| bpm-key | `bpm` (rounded, "128"), `bpm_exact` ("127.9"), `key` ("A minor"), `key_short` ("Am"), `camelot` ("8A") |
| transcribe | `transcript` (plain text), `transcript_timed` (one `[h:mm:ss] text` line per segment; needs `srt`, `vtt` or `json`), `language` |
| ocr | `text` (needs a `.txt` output) |
| subtitles (auto) | `subtitles` (the cue text, one cue per line), `language` |
| audio-to-midi | `notes` |
| pipelines.chat | write mode: `reply`; extract mode: one variable per field |

- **Expansion:** `core.ExpandVars(tpl, maps...)`, where later maps win.
  - An unknown name expands to "" and logs a warning on the cell.
  - Values are capped at 256 KiB each (truncated, with a log line) and 1 MiB per item in total.
- **Where `{vars}` work:** the option fields listed in `StepInfo.Templates`, which are JSON pointers into the step options. Describe reports a problem for any name that no earlier step (or built-in) defines there.

---

## 5. Wire types (`core/pipeline_types.go`, new; in the bindings)

```go
// Pipeline is a saved chain of steps.
type Pipeline struct {
	ID          string         `json:"id"`          // ULID; "" when unsaved
	Name        string         `json:"name"`        // 1–80 chars, unique ignoring case
	Description string         `json:"description"` // ≤ 300 chars
	TemplateID  string         `json:"templateId"`  // the template it came from ("" = blank)
	Steps       []PipelineStep `json:"steps"`       // 1–30
	Watch       WatchConfig    `json:"watch"`
	CreatedAt   int64          `json:"createdAt"`
	UpdatedAt   int64          `json:"updatedAt"`
}

// PipelineStep is one step of a pipeline.
type PipelineStep struct {
	ID           string     `json:"id"`           // 8 chars [a-z0-9], unique in the pipeline; not "input"/"none"
	Type         string     `json:"type"`         // StepType.ID
	Label        string     `json:"label"`        // optional title (≤ 60); "" = the type's name
	OptionsJSON  string     `json:"optionsJson"`  // the type's step options; "{}" for manual and check steps
	From         string     `json:"from"`         // "input" | "none" | an earlier step's ID
	Filter       StepFilter `json:"filter"`
	Manual       bool       `json:"manual"`       // "I'll do this step myself"
	AutoContinue bool       `json:"autoContinue"` // manual: continue when an adopted job finishes with files
	Keep         bool       `json:"keep"`         // keep this step's files in the Library after the run
	Note         string     `json:"note"`         // manual/check: shown on the "needs you" card (≤ 200)
}

// StepFilter narrows the files a step reads. Empty fields match anything;
// all set fields must match.
type StepFilter struct {
	Roles []string     `json:"roles"`
	Kinds []OutputKind `json:"kinds"`
	Exts  []string     `json:"exts"` // lowercase with the dot
	Name  string       `json:"name"` // case-insensitive substring of the file name
}

// WatchConfig is a pipeline's watch folder.
type WatchConfig struct {
	Enabled bool   `json:"enabled"`
	Folder  string `json:"folder"` // absolute
}

// StepType is an entry of the step catalogue.
type StepType struct {
	ID           string   `json:"id"`       // module ID, or "pipelines.<action>", or "pipelines.check"
	ModuleID     string   `json:"moduleId"` // the module whose jobs it runs ("" for check)
	Name         string   `json:"name"`
	Icon         string   `json:"icon"`
	Category     Category `json:"category"`
	Description  string   `json:"description"` // one sentence for the Add-step menu
	Auto         bool     `json:"auto"`        // can run automatically
	Manual       bool     `json:"manual"`      // can be done by hand in its tool
	Builtin      bool     `json:"builtin"`
	Accepts      Accepts  `json:"accepts"`     // the widest it reads, over all options
	DefaultsJSON string   `json:"defaultsJson"`
}

// StepInfo is what a step does with given options (core.Chainable.DescribeStep).
type StepInfo struct {
	Accepts   Accepts       `json:"accepts"`
	Produces  []StepProduct `json:"produces"`
	Vars      []StepVar     `json:"vars"`
	Together  bool          `json:"together"`
	NoFiles   bool          `json:"noFiles"`   // may run with From "none" or zero files
	Secrets   []StepSecret  `json:"secrets"`   // asked for when a run starts; never stored
	Templates []string      `json:"templates"` // JSON pointers of option strings that take {vars}
	Warnings  []string      `json:"warnings"`  // e.g. "Download a model in Local Chat first"
	Summary   string        `json:"summary"`   // one line, e.g. "MP4 · H.264 · ≤ 1080p"
}

// StepProduct is one kind of file a step makes.
type StepProduct struct {
	Role  string     `json:"role"`  // stable: "vocals", "video", "subtitles"; "" = the main file
	Label string     `json:"label"` // "Vocals"
	Kind  OutputKind `json:"kind"`  // "" = same as its input
	Exts  []string   `json:"exts"`  // nil = same as its input
	Many  bool       `json:"many"`  // may make several of this per item
}

type StepVar struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

type StepSecret struct {
	Key   string `json:"key"`   // unique within the step
	Label string `json:"label"` // "PDF password"
}

// PipelineCheck is Describe's answer for a whole pipeline.
type PipelineCheck struct {
	Steps    []StepCheck   `json:"steps"`    // same order as the pipeline's
	Accepts  Accepts       `json:"accepts"`  // what a run takes: the union over steps with From "input"
	Problems []string      `json:"problems"` // pipeline-level: name, no steps, too many steps, watch folder
	Secrets  []SecretAsk   `json:"secrets"`  // asked for at Start
	Missing  []string      `json:"missing"`  // dep IDs not installed (descriptor Requires of its modules)
	Ready    bool          `json:"ready"`    // no problems anywhere and nothing missing
}

type StepCheck struct {
	StepID   string   `json:"stepId"`
	Info     StepInfo `json:"info"`     // Produces resolved: no "same as input" left (§8.8)
	Problems []string `json:"problems"` // block running
	Vars     []StepVar `json:"vars"`    // variables this step can use: built-ins + earlier steps'
}

type SecretAsk struct {
	StepID string `json:"stepId"`
	Key    string `json:"key"`
	Label  string `json:"label"` // "Step 3 · PDF password"
}

// PipelineEntry is a pipeline as listed (pipelines:changed carries all of them).
type PipelineEntry struct {
	Pipeline Pipeline      `json:"pipeline"`
	Check    PipelineCheck `json:"check"`
	Watch    WatchState    `json:"watch"`
	LastRun  *RunBrief     `json:"lastRun"`
}

type WatchState struct {
	Active  bool   `json:"active"`  // enabled and polling
	Message string `json:"message"` // "" = fine; else why it's paused ("Fix the problems in step 2")
}

type RunBrief struct {
	ID        string    `json:"id"`
	Status    RunStatus `json:"status"`
	CreatedAt int64     `json:"createdAt"`
}

type PipelineTemplate struct {
	ID       string   `json:"id"`
	Blurb    string   `json:"blurb"` // one sentence
	Icon     string   `json:"icon"`
	Packs    []string `json:"packs"` // pack IDs it needs (for the "needs" chip)
	Pipeline Pipeline `json:"pipeline"`
}

type RunStatus string

const (
	RunRunning   RunStatus = "running"
	RunWaiting   RunStatus = "waiting"   // at least one cell needs the user
	RunDone      RunStatus = "done"      // every item succeeded
	RunPartial   RunStatus = "partial"   // some items failed, cancelled or blocked
	RunFailed    RunStatus = "failed"    // no item succeeded
	RunCancelled RunStatus = "cancelled" // the user cancelled the run
)

type CellStatus string

const (
	CellPending   CellStatus = "pending"
	CellPreparing CellStatus = "preparing"
	CellRunning   CellStatus = "running"
	CellWaiting   CellStatus = "waiting" // Wait says why
	CellDone      CellStatus = "done"
	CellFailed    CellStatus = "failed"
	CellCancelled CellStatus = "cancelled"
	CellSkipped   CellStatus = "skipped"
	CellBlocked   CellStatus = "blocked" // an earlier cell failed or was cancelled
	CellMerged    CellStatus = "merged"  // gathered into a merged item at this together step
	CellNone      CellStatus = "none"    // not applicable (merged items before their merge; items after it)
)

type WaitKind string

const (
	WaitManual    WaitKind = "manual"    // do this step in its tool
	WaitCheck     WaitKind = "check"     // look at the files
	WaitCondition WaitKind = "condition" // e.g. "Unlock the Vault to continue"; retried every 5 s
)

type PipelineRun struct {
	ID         string         `json:"id"`
	PipelineID string         `json:"pipelineId"`
	Name       string         `json:"name"`  // the pipeline's name at start
	Steps      []PipelineStep `json:"steps"` // snapshot
	Status     RunStatus      `json:"status"`
	Trigger    string         `json:"trigger"` // "manual" | "watch"
	Inputs     []string       `json:"inputs"`
	Items      []RunItem      `json:"items"`
	NeedsYou   int            `json:"needsYou"` // cells waiting with WaitManual or WaitCheck
	Error      string         `json:"error"`    // run-level, e.g. a failed preflight
	Cleaned    bool           `json:"cleaned"`  // temporary files were deleted
	CreatedAt  int64          `json:"createdAt"`
	FinishedAt int64          `json:"finishedAt"`
}

type RunItem struct {
	Index    int               `json:"index"`    // 0-based; merged items take the next free index
	Label    string            `json:"label"`    // input name, the download title, or "All 12 files"
	Input    string            `json:"input"`    // "" for merged items
	Merged   []int             `json:"merged"`   // merged item: the items it gathers
	MergedAt string            `json:"mergedAt"` // merged item: the together step that made it
	Cells    []RunCell         `json:"cells"`    // one per step, same order
	Vars     map[string]string `json:"vars"`     // previews: ≤ 300 chars each
}

type RunCell struct {
	StepID     string     `json:"stepId"`
	Status     CellStatus `json:"status"`
	Wait       WaitKind   `json:"wait"` // when waiting
	JobIDs     []string   `json:"jobIds"`
	Inputs     []RunFile  `json:"inputs"` // what it was given
	Files      []RunFile  `json:"files"`  // what it made (check: what was kept)
	Message    string     `json:"message"`
	ErrorCode  ErrorCode  `json:"errorCode"`
	Error      string     `json:"error"`
	ErrorHint  string     `json:"errorHint"`
	StartedAt  int64      `json:"startedAt"`
	FinishedAt int64      `json:"finishedAt"`
}

type RunFile struct {
	Path      string     `json:"path"`
	Name      string     `json:"name"`
	Kind      OutputKind `json:"kind"`
	Role      string     `json:"role"`
	RoleLabel string     `json:"roleLabel"`
	OutputID  string     `json:"outputId"`  // "" when not a Library output (a run input, a link)
	Temporary bool       `json:"temporary"` // deleted when the run is cleaned up
	Missing   bool       `json:"missing"`   // computed when a run is read
}

type RunRequest struct {
	PipelineID string            `json:"pipelineId"`
	Inputs     []string          `json:"inputs"`  // paths or http(s) links; 1–200
	Secrets    map[string]string `json:"secrets"` // "<stepId>.<key>" → value
}

type RunFilter struct {
	PipelineID string `json:"pipelineId"` // "" = all
	ActiveOnly bool   `json:"activeOnly"`
	Limit      int    `json:"limit"` // default 50, max 200
}

type ContinueRequest struct {
	RunID  string   `json:"runId"`
	Item   int      `json:"item"`
	StepID string   `json:"stepId"`
	// Keep lists the paths to carry on (check: a subset of the inputs; manual:
	// a subset of the adopted files). nil = all.
	Keep []string `json:"keep"`
	// PassThrough (manual): continue with the step's inputs unchanged.
	PassThrough bool `json:"passThrough"`
}

// PipelinesChanged is the payload of pipelines:changed.
type PipelinesChanged struct {
	Pipelines []PipelineEntry `json:"pipelines"`
}

// RunsRemoved is the payload of pipelines:runs-removed.
type RunsRemoved struct {
	IDs []string `json:"ids"`
}
```

**Job changes** (`core/types.go`):
- `Job` gains `PipelineRunID string \`json:"pipelineRunId"\`` and `PipelineStepID string \`json:"pipelineStepId"\``. Both are "" for ordinary jobs.

**New error code:**
- `CodeWaiting ErrorCode = "waiting"`, plus `core.ErrWaiting(message, hint string) *AppError`. An adapter returns it from `PrepareStep` when a condition must clear first.

**New event names** (`core/events.go`):
- `EventPipelinesChanged = "pipelines:changed"` carries `PipelinesChanged`.
- `EventPipelinesRun = "pipelines:run"` carries `PipelineRun`, throttled to one per 250 ms per run, with the latest snapshot always delivered.
- `EventPipelinesRunsRemoved = "pipelines:runs-removed"` carries `RunsRemoved`.

---

## 6. Step adapters

### 6.1 The interface (`core/steps.go`, new)

```go
// Chainable is implemented by modules that can run as automatic pipeline
// steps (SPEC.md §6). Implementations live in modules/<id>/pipeline.go.
type Chainable interface {
	// StepDefaults returns the options a new step starts with (JSON-marshalable).
	StepDefaults() any
	// DescribeStep checks options without inputs and says what the step
	// takes and makes. Return ValidationError for bad options.
	DescribeStep(options json.RawMessage) (StepInfo, error)
	// PrepareStep turns one item's files (or, when Together, every merged
	// item's) into job submissions for this module. It may probe the files.
	// ErrWaiting(...) means "not yet": the runner retries every 5 s.
	PrepareStep(ctx context.Context, req StepRequest) ([]StepJob, error)
	// StepOutputs reads a finished (done) job back: its files with roles,
	// and its variables. It may read the output files (≤ 1 MiB of text).
	StepOutputs(job Job) (StepResult, error)
}

type StepRequest struct {
	RunID    string
	StepID   string
	Pipeline string            // the pipeline's name
	Options  json.RawMessage   // the step's options, unexpanded
	Item     StepItem          // each-item steps
	Items    []StepItem        // together steps: every merged item, in order (§4.2 rule 5)
	Secrets  map[string]string // this step's secrets by key
	Started  int64             // the run's start (for {date}/{time})
}

type StepItem struct {
	Index int
	Label string
	Files []RunFile         // already filtered and accepted
	Vars  map[string]string // built-ins + every earlier step's
}

type StepJob struct {
	Inputs  []string
	Options any // marshalled to the job's options
}

type StepResult struct {
	Files []RunFile         // Role/RoleLabel set; Kind may be "" (filled from the extension)
	Vars  map[string]string
}

// ExpandVars replaces {name} with the value from the last map defining it;
// unknown names become "" and are returned in missing. "{{"/"}}" are braces.
func ExpandVars(tpl string, maps ...map[string]string) (out string, missing []string)

// FileVars are the per-file built-ins: name, ext, role.
func FileVars(f RunFile) map[string]string

// TemplateVars returns the variable names used in tpl (for Describe checks).
func TemplateVars(tpl string) []string
```

**Manual steps** don't need `Chainable`. Every ready, visible, non-job-less module whose `Accepts` isn't empty can be a manual step.
- Files from an adopted job are read with the module's `StepOutputs` when it is `Chainable`.
- Otherwise every output is a file with role "" and the kind taken from its extension.

**Shared rules for every adapter:**
- `PrepareStep` decodes options with `core.DecodeOptionsJSON` and fills unset fields from the defaults where the module has no `withDefaults`.
- It expands `{vars}` with `FileVars(file)` over `Item.Vars` for per-file fields.
- It returns jobs the module's `Validate` will accept.
- Grouping is the adapter's call. Use one submission with every file for `SplitInputs` modules: the job manager splits them.

### 6.2 Step catalogue

All of these are **automatic and manual** unless marked. "Same" means the same kind and extension as the input.

| Type | Step options (Go type) | Accepts | Grouping | Produces (role → kind/ext) | Vars | Notes |
|---|---|---|---|---|---|---|
| `downloader` | `downloader.Options` (defaults with `Playlist: false`) | URLs | one submission per item | `""` → audio .mp3/.wav/.flac by format, or video .mp4; `Many` when Playlist | title, url | The item label becomes the job title once known |
| `converter` | `converter.Options` | per preset (audio presets: audio+video; video: video; image: images) | one submission | `""` → the preset's kind and ext | — | Image presets now honour `MaxHeight` (§6.3) |
| `trimmer` | `trimmer.StepOptions` (§6.3) | audio + video | one job per file | `""` → same (fast) or .mp4 / the audio family (precise) | — | Segments resolved at run time |
| `subtitles` | `subtitles.StepOptions` (§6.4) | audio + video | one job per file | `subtitles` → .srt/.vtt (Many); `video` → .mp4 (burn) or same container (embed) | subtitles, language | Uses the new action `auto` |
| `audio-cleanup` | `audiocleanup.StepOptions` (Options without the preview fields) | audio + video | one submission | `""` → same (audio: the chosen format) | — | |
| `lyric-video` | `lyricvideo.StepOptions` (§6.4) | audio | one job per file | `video` → .mp4; `lyrics` → .lrc | — | Action `auto`; Title and Artist take `{vars}` |
| `visualizer` | `visualizer.StepOptions` (§6.4) | audio + video | one job per file | `video` → .mp4; with SaveStems: `vocals`/`drums`/`bass`/`other` → .flac | — | Action `auto`; rendering uses the always-mounted RenderHost, so the app must be running (it is) |
| `redact` | `redact.StepOptions` (the `RedactSettings` fields) | images + video | per item: all images in one job, each video alone | `""` → same (TIFF → .png, HEIC/.jpeg → .jpg; video → .mp4) | — | Action `auto` |
| `stems` | `stems.Options` | audio + video | one submission | per preset: `vocals`, `instrumental` or `vocals`, `drums`, `bass`, `other` → audio by format | — | Roles from `Result.stems[].name`, lowercased |
| `bpm-key` | `bpmkey.Options` (empty struct) | audio + video | one submission | nothing | bpm, bpm_exact, key, key_short, camelot | |
| `audio-to-midi` | `midi.Options` | audio + video | one submission | `midi` → other .mid | notes | |
| `transcribe` | `transcribe.Options` | audio + video | one submission | `text` → .txt; `subtitles` → .srt/.vtt; `json` → .json (per Formats) | transcript, transcript_timed (srt/vtt/json), language | `transcript` reads .txt, else the cues of .srt/.vtt, else .json |
| `ocr` | `ocr.Options` | pdf + images | one submission | images: `text` → .txt or `json` → .json; PDFs: `pdf` → .pdf and/or `text` → .txt | text | |
| `pdf` | `pdf.StepOptions` (§6.3) | per action | §6.3 | §6.3 | — | Passwords are asked at run start |
| `vault` | `vault.StepOptions{Folder}` | any | one job per item, all its files | nothing (files are copied into the Vault) | — | Waits while the Vault is locked |
| `bg-remover` | `bgremove.Options` | its images | one submission | `cutout` (transparent/colour) or `mask` → image .png | — | |
| `upscaler` | `upscale.Options` | its images | one submission | `""` → image (ext by Format) | — | An input over the size cap fails its cell with Validate's message |
| `exif` | `exif.Options` (`Fields` values take `{vars}`) | the writable images (.jpg .jpeg .png .webp .gif .heic .tif .tiff) | one submission | `""` → same | — | |
| `object-eraser` | — | its images | — | manual only | — | `Auto: false` |
| `pipelines.*` | §7 | §7 | §7 | §7 | §7 | Built-ins |

`StepInfo.Summary` examples:
- downloader: "Video · up to 1080p" or "Audio · MP3 320"
- converter: the preset label (+ "· ≤ 720p")
- stems: "4 stems · fast · FLAC"
- transcribe: "Small model · TXT, SRT"
- pdf: "Merge into one PDF"

### 6.3 Changes inside modules (besides `pipeline.go`)

**Trimmer** (`modules/trimmer/pipeline.go`):

```go
type StepKeep string

const (
	KeepWhole StepKeep = "whole"
	KeepFirst StepKeep = "first" // the first Seconds
	KeepLast  StepKeep = "last"  // the last Seconds
	KeepRange StepKeep = "range" // From–To
)

type StepOptions struct {
	Keep        StepKeep `json:"keep"`
	Seconds     float64  `json:"seconds"` // first/last: 1–36,000
	From        string   `json:"from"`    // range: timecode, "" = start
	To          string   `json:"to"`      // range: timecode, "" = end
	Mode        Mode     `json:"mode"`
	Aspect      Aspect   `json:"aspect"`
	CropX       float64  `json:"cropX"`
	CropY       float64  `json:"cropY"`
	MaxSizeMB   int      `json:"maxSizeMB"`
	MaxHeight   int      `json:"maxHeight"`
	RemoveAudio bool     `json:"removeAudio"`
}
// Defaults: whole, 30 s, precise, keep, 0.5/0.5, 0, 0, false.
```

- `PrepareStep` probes each file (ffprobe) and builds one segment.
- The segment is clamped to the file's length. If it comes out shorter than 100 ms, the cell fails with "This file is shorter than the part to keep".
- `whole` with fast mode and nothing else set is a problem in Describe ("Nothing to do: pick a part, a shape or a size").

**Converter:**
- Image presets apply `MaxHeight`: they scale down only, keep the aspect ratio, and use the same `scale=-2:min(ih,N)` filter as video.
- The tool's view stops hiding the height control for image presets.

**PDF Toolkit** (`modules/pdf/pipeline.go`):

```go
type StepOptions struct {
	Action      Action `json:"action"` // merge | split | compress | images-to-pdf | pdf-to-images | protect | unlock
	Every       int    `json:"every"`  // split: pages per file, ≥ 1
	Level       string `json:"level"`
	PageSize    string `json:"pageSize"`
	Margin      string `json:"margin"`
	ImageFormat string `json:"imageFormat"`
	DPI         int    `json:"dpi"`
}
```

- **merge** and **images-to-pdf** are `Together` and make one job over every file. They produce `pdf` → .pdf.
  - Merge with a single file passes it through unchanged instead of failing.
- **split**, **compress**, **pdf-to-images**, **protect** and **unlock** run one job per file.
  - split and pdf-to-images produce `Many` files: .pdf for split, and `page` → images for pdf-to-images.
- **compress** with no output ("Already compact") passes its input through.
- **Secrets:**
  - protect asks for `password` (the new password);
  - unlock asks for `password`.
  - `PrepareStep` stores them in the module's in-memory secret store and puts the `passwordRef` in the job options.
  - The submission goes through the same document checks as `Service.Enqueue` (`checkDocuments`). Its failures fail the cell with that message.

**Vault** (`modules/vault/pipeline.go`):
- `StepOptions{Folder string}`, where `Folder` takes `{vars}` and is cleaned as in `Validate`.
- **Locked** → `ErrWaiting("Unlock the Vault to continue", "Open the Vault and unlock it")`.
- `StepOutputs` returns no files, since Vault adds make none.

**Audio Cleanup, Redact:** a `StepOptions` struct each (fields listed in §6.2), mapped to `Options` with `Preview: false` / `Action: auto`.

**Every module service** whose step options type isn't already in the bindings gains `StepShape() StepOptions` (bindings only, like `ResultShape`). That covers trimmer, subtitles, audio-cleanup, lyric-video, visualizer, redact, pdf and vault.

### 6.4 New `auto` actions

**Subtitles: `ActionAuto Action = "auto"`.** One job does generate, then optional translate, then save, burn and/or embed.

```go
// New Options fields (auto):
Video     string `json:"video"`     // auto: "none" | "burn" | "embed"
MaxSizeMB int    `json:"maxSizeMB"` // auto burn: 0 = no limit, else 1–4000 (bitrate from duration, as Trimmer)

// modules/subtitles/pipeline.go
type StepOptions struct {
	Model              string           `json:"model"`
	Language           string           `json:"language"`
	TranslateToEnglish bool             `json:"translateToEnglish"` // Whisper's own translation
	TargetLanguage     string           `json:"targetLanguage"`     // "" = keep; else via Local Chat
	MaxLineChars       int              `json:"maxLineChars"`
	MaxLines           int              `json:"maxLines"`
	Save               []string         `json:"save"`  // "srt", "vtt" (0–2)
	Video              string           `json:"video"` // "none" | "burn" | "embed"
	Style              Style            `json:"style"`
	Size               string           `json:"size"`
	Position           string           `json:"position"`
	Font               string           `json:"font"`
	TrackLanguage      string           `json:"trackLanguage"`
	MaxSizeMB          int              `json:"maxSizeMB"`
	Canvas             string           `json:"canvas"`          // audio input + burn
	CanvasHeight       int              `json:"canvasHeight"`
	Background         string           `json:"background"`      // "color" | "image" | "visualizer"
	BackgroundColor    string           `json:"backgroundColor"`
	BackgroundPath     string           `json:"backgroundPath"`
	Visuals            *viz.VisualsSpec `json:"visuals"`
}
```

- **Validate (auto):**
  - The input must be media.
  - At least one of `Save` or `Video` ≠ "none".
  - embed needs a video. burn on audio needs a valid background (the existing canvas checks).
  - `TargetLanguage` requires `TextGenerator.Ready()` at **Run**, failing with Translate's existing hint.
- **Run:**
  1. Generate the cues (as `generate`).
  2. No speech found → fail with `CodeValidation` "No speech found" and the hint "Check the audio has speech".
  3. Translate if set.
  4. Save each format in `Save`, then burn or embed with the same code paths as those actions.
- **Progress** is split 0–60 % (generate), 60–75 % (translate), 75–100 % (video).
- **`Result`**: `Action: auto`, with `Language`, `Cues` and `Outputs` as today.
- **`StepOutputs`**: `subtitles` files (.srt/.vtt) and the `video` file. The `subtitles` variable is read from the cues.

**Lyric Video: `ActionAuto Action = "auto"`.**
- One job runs `lyrics` with `Source: detect`, then `render` with the lines it got.
- Uses `Language`, `Look`, `Audio`, `Aspect` and `Height` from the options.
- Fewer than 1 line → fail "No lyrics heard", with the hint "Use Lyric Video with pasted lyrics".

```go
// modules/lyricvideo/pipeline.go
type StepOptions struct {
	Language string `json:"language"`
	Look     Look   `json:"look"`   // Look.Title / Look.Artist take {vars} (default "{title}" / "")
	Audio    string `json:"audio"`  // "original" | "instrumental"
	Aspect   string `json:"aspect"`
	Height   int    `json:"height"`
}
```

- **Progress** is 0–55 % lyrics, then 55–100 % render.
- **`Result`**: `Action: auto`, with `Lines`, `Matched` and `Outputs`.
- **Produces:** `video` → .mp4 and `lyrics` → .lrc.

**Visualizer: `ActionAuto Action = "auto"`.**
- One job runs analyze with `Analyze`, then render with the new ref's key and the other render fields.

```go
// modules/visualizer/pipeline.go
type StepOptions struct {
	PresetID   string `json:"presetId"`   // the preset it came from ("" = a saved design); a label only
	DesignName string `json:"designName"` // shown in the summary
	ShowJSON   string `json:"showJson"`   // required, ≤ 512 KiB
	Mode       Mode   `json:"mode"`       // full | overlay (overlay needs a video input)
	Aspect     string `json:"aspect"`
	Height     int    `json:"height"`
	FPS        int    `json:"fps"`
	Audio      string `json:"audio"`      // "original" | "instrumental" (needs Stems)
	Background string `json:"background"` // "none" | "cover"
	Stems      bool   `json:"stems"`
	SaveStems  bool   `json:"saveStems"`
	Words      string `json:"words"`    // "none" | "detect"
	Language   string `json:"language"` // words: "" = auto
	Mood       bool   `json:"mood"`
}
```

- Validate and Run reuse the analyze and render paths.
- **Progress** is 0–40 % analyze (it may be cached), then 40–100 % render.
- An empty `ShowJSON` is a Describe problem: "Pick a design".
- **Instrumental audio** without `Stems` is a problem.

---

## 7. Built-in steps (`modules/pipelines`, ID `pipelines`)

**The module.**
- Descriptor: Name "Pipelines", Tagline "Chain tools into one-click workflows", Icon `workflow`, Category utility, OutputSubdir `Pipelines`, Order 0.
- It has no `Accepts`: drops never match it as a tool, and pipelines are matched separately (§11.6). It has no Requires.
- It is listed in the sidebar as its own item (§11.1), not among the tools.
- Its view is the Pipelines page.
- Its jobs run the five built-in actions. Built-in files go to `<library>/Pipelines/<pipeline name>/`, with the name cleaned for the file system.

```go
type Action string

const (
	ActionRename Action = "rename"
	ActionChat   Action = "chat"
	ActionTable  Action = "table"
	ActionZip    Action = "zip"
	ActionCopy   Action = "copy"
)

// Options are the job options (made by PrepareStep; everything expanded).
type Options struct {
	Action   Action      `json:"action"`
	Pipeline string      `json:"pipeline"` // folder name under Pipelines/
	Rename   []RenameOp  `json:"rename"`
	Chat     *ChatJob    `json:"chat"`
	Table    *TableJob   `json:"table"`
	Zip      *ZipJob     `json:"zip"`
	Copy     *CopyJob    `json:"copy"`
}

type RenameOp struct {
	Path   string `json:"path"`
	Name   string `json:"name"`   // new base name, no extension
	Move   bool   `json:"move"`   // true: a file this run made (renamed in place); false: copied into Pipelines/<name>/
	Role   string `json:"role"`   // carried through
}

type ChatJob struct {
	Mode        string            `json:"mode"`   // "write" | "extract"
	System      string            `json:"system"` // ≤ 4,000
	Prompt      string            `json:"prompt"` // the template, unexpanded (expansion happens in Run, for chunking)
	Vars        map[string]string `json:"vars"`   // only the variables the prompt uses
	Fields      []ChatField       `json:"fields"` // extract
	OutputName  string            `json:"outputName"` // write: expanded base name
	Format      string            `json:"format"`     // write: "md" | "txt"
	SaveJSON    bool              `json:"saveJson"`   // extract: also write <name>.json
	Temperature float64           `json:"temperature"`
}

type ChatField struct {
	Name  string `json:"name"`  // variable name, [a-z][a-z0-9_]{0,31}
	Label string `json:"label"` // shown and given to the model ("Merchant")
	Type  string `json:"type"`  // "text" | "number" | "date"
}

type TableJob struct {
	Name   string     `json:"name"` // base name
	Header []string   `json:"header"`
	Rows   [][]string `json:"rows"`
}

type ZipJob struct {
	Name  string   `json:"name"`
	Files []string `json:"files"`
}

type CopyJob struct {
	Folder string   `json:"folder"` // absolute, chosen by the user
	Files  []string `json:"files"`
}

// StepOptions are what the user edits, one struct per built-in type.
type RenameStep struct {
	Template string `json:"template"` // default "{name}"; takes {vars}
}

type ChatStep struct {
	Mode        string      `json:"mode"`        // "write" | "extract"
	System      string      `json:"system"`
	Prompt      string      `json:"prompt"`      // takes {vars}; ≤ 8,000 chars
	Fields      []ChatField `json:"fields"`      // extract: 1–12
	OutputName  string      `json:"outputName"`  // write: default "{item} (notes)"; takes {vars}
	Format      string      `json:"format"`      // write: md | txt
	SaveJSON    bool        `json:"saveJson"`
	Temperature float64     `json:"temperature"` // 0–1.5, default 0.3
}

type TableColumn struct {
	Header string `json:"header"`
	Value  string `json:"value"` // takes {vars}
}

type TableStep struct {
	Name    string        `json:"name"`    // default "{pipeline} {date}"; takes the run's built-ins only
	Columns []TableColumn `json:"columns"` // 1–30
}

type ZipStep struct {
	Together bool   `json:"together"` // one zip for the whole run (else one per item)
	Name     string `json:"name"`     // default "{item}" / "{pipeline} {date}"; takes {vars}
}

type CopyStep struct {
	Folder    string `json:"folder"`    // absolute, chosen with the folder picker
	Subfolder string `json:"subfolder"` // takes {vars}; "" = none, e.g. "{pipeline}/{date}"
}
```

**`Service.StepShape*()` methods** expose these types to the bindings: `RenameShape`, `ChatShape`, `TableShape`, `ZipShape`, `CopyShape`.

### 7.1 Rename files (`pipelines.rename`)
- **Shape:** each item, any files, `Template` takes `{vars}`.
- **Result:** a file this run made is **renamed in place** (`Move: true`). Anything else, i.e. the run's own inputs, is copied into `Pipelines/<pipeline>/` under the new name. Run inputs are never moved.
- **Names:**
  - The extension is kept.
  - Characters that are illegal on either OS (`<>:"/\|?*` and control characters) become "-". Whitespace is collapsed and the name is trimmed to 150 characters.
  - An empty result keeps the old name.
  - Collisions get `UniquePath`.
- **Library record:** a moved file keeps its Library record, via `OutputStore.MoveOutput` (§9.1), and emits `library:added` with the updated output.
- **Roles** are kept, so a later filter on "Bass" still works.
- **Produces:** the same kind and role as the input.

### 7.2 Copy to folder (`pipelines.copy`)
- **Shape:** each item, any files.
- **What it does:** copies the files into `Folder[/Subfolder]` (created if missing) and never overwrites (`UniquePath`).
- **Folder rules:**
  - It must be absolute, exist when the step is saved (a Describe problem otherwise), and not be inside the Library.
  - It may be anywhere else the user picks. This is the user's own destination, like an export.
- **Output:** the copies are not Library outputs; the step's `Files` are the originals.

### 7.3 Ask Local Chat (`pipelines.chat`)
- **Shape:** each item, `NoFiles: true`.
- **Accepts** text files: .txt .md .srt .vtt .json .csv, ≤ 256 KiB each.
- **The prompt** may use `{file}`, the text of the step's input files joined with blank lines (`.srt`/`.vtt` reduced to their cue text), plus any variable.
- **Write mode:** the reply is saved as `<OutputName>.<md|txt>` in `Pipelines/<pipeline>/`, with role `text`. The variable `reply` holds the reply.
- **Extract mode:**
  - The model replies with `CompletionRequest.JSONSchema` = an object with one string property per field. Number fields are described as numbers but still returned as strings. Every field is required.
  - Each field becomes a variable.
  - With `SaveJSON`, the reply is also written as `<item>.json`.
  - A reply that doesn't parse is retried once at temperature 0, then fails the cell with "The chat model's answer wasn't usable".
- **Long text:**
  - `core.TextGenerator` gains `ContextTokens() int` (chat implements it from `Settings.Chat.ContextSize`; Ollama returns 8192).
  - The budget for the prompt is `ContextTokens × 0.7 − 1,024` tokens, estimated at 3.5 characters per token.
  - If the expanded prompt is over the budget, the longest variable used (or `{file}`) is split into chunks of half the budget, on paragraph or line boundaries.
  - Each chunk gets "Take concise notes of this part of a longer text, keeping any [h:mm:ss] timestamps:" (map).
  - The notes, joined, then replace that variable in the user's prompt (reduce).
  - The log says "Long text: read in N parts".
- **Requests:** `Purpose: "Pipeline · <step label>"`, `MaxTokens` 2,048 (write) or 512 (extract), and the step's temperature.
- **Model check:** `Ready()` fails → the cell fails with that error. Describe also shows it as a warning, using `StepInfo.Warnings`.
- **Produces:** `text` → .md/.txt (write), `json` → .json (extract + SaveJSON).

### 7.4 Make a table (`pipelines.table`)
- **Shape:** `Together`, `NoFiles: true`.
- **Rows:** one per merged item, in item order. Each column's `Value` is expanded with that item's variables.
- **Output:** one CSV (RFC 4180, UTF-8 with BOM so spreadsheet apps read accents) in `Pipelines/<pipeline>/<Name>.csv`.
- **Produces:** `table` → document .csv.

### 7.5 Zip (`pipelines.zip`)
- **Shape:** each item, or `Together` (`ZipStep.Together`).
- **What it does:** writes `<Name>.zip` to `Pipelines/<pipeline>/` with every input file at the zip's top level. Duplicate names get " (2)".
- **Compression:** files already compressed (audio, video, images, .zip, .pdf) are stored; others use Deflate.
- **Produces:** `zip` → other .zip.

### 7.6 Check (`pipelines.check`)
- **Not a job.** It accepts anything and produces the same.
- **Pause:** the item waits (`WaitCheck`) with its input files. `Continue{Keep}` carries the kept files on, and keeping none skips the rest of the item (§8.5).
- **Note:** an optional text shown on the card, e.g. "Check the faces are all blurred".

---

## 8. The runner (`core/pipeline`)

```go
package pipeline // imports core only

type Config struct {
	Store    core.PipelineStore
	Outputs  core.OutputStore
	Jobs     *core.Jobs
	Reg      *core.Registry
	Em       core.Emitter
	Tools    func(depID string) (string, error) // dependency check at Start
	Settings func() core.Settings
	Clock    func() time.Time // tests
}

func New(cfg Config) *Runner
func (r *Runner) RegisterBuiltin(t core.StepType, a core.Chainable) error // modules/pipelines
func (r *Runner) Start(ctx context.Context) error // after Jobs.Start: load, reconcile, observe, watch
func (r *Runner) Stop()                           // idempotent; stops the loop, watchers and persists

// Pipelines
func (r *Runner) List() []core.PipelineEntry
func (r *Runner) Get(id string) (core.Pipeline, error)
func (r *Runner) Catalog() []core.StepType
func (r *Runner) Describe(p core.Pipeline) core.PipelineCheck
func (r *Runner) Save(p core.Pipeline) (core.PipelineEntry, error)
func (r *Runner) Delete(id string) error
func (r *Runner) Duplicate(id string) (core.PipelineEntry, error)

// Runs
func (r *Runner) StartRun(req core.RunRequest, trigger string) (core.PipelineRun, error)
func (r *Runner) Runs(f core.RunFilter) ([]core.PipelineRun, error)
func (r *Runner) Run(id string) (core.PipelineRun, error)
func (r *Runner) Cancel(runID string) error
func (r *Runner) Retry(runID string) (core.PipelineRun, error)
func (r *Runner) Continue(req core.ContinueRequest) error
func (r *Runner) SkipStep(runID string, item int, stepID string) error // manual/check: carry the inputs on
func (r *Runner) StopItem(runID string, item int) error                // cancel this item's active jobs; later cells blocked
func (r *Runner) CleanUp(runID string) (int, error)                    // delete temporary files now
func (r *Runner) Remove(runID string, deleteTemporary bool) error      // finished runs only

// OnNeedsYou is called (from the loop) whenever the total of NeedsYou over
// active runs changes; main.go wires it to the tray.
func (r *Runner) OnNeedsYou(fn func(total int, firstRunName string))
```

### 8.1 Event loop
- **One goroutine** owns all run state. Everything reaches it through one channel:
  - commands (start, cancel, continue, …), each with a reply channel;
  - job snapshots from `Jobs.Observe`;
  - prepare results;
  - timers: wait retries every 5 s, persistence.
- **The observer callback only enqueues.** It never blocks: an unbounded slice queue sits behind the channel.
- **After every change, `schedule()`** walks the active runs and starts ready cells:
  - deepest step first, then lower item index, so results arrive early;
  - each run keeps at most `max(2, Settings.Concurrency)` cells preparing or with active jobs.
- **Preparing:** `PrepareStep` runs in its own goroutine with a context cancelled by Cancel/StopItem, and its result goes back into the loop.
- **Submitting:** for each `StepJob`, the loop calls `Jobs.SubmitFor` with the tag. A submit error fails the cell with that `AppError`; jobs already submitted for that cell are cancelled.
- **Zero `StepJob`s** → the cell is done with no files.

### 8.2 Cells from job updates
- **When every job of a cell has finished:**
  - all done → `StepOutputs` per job, in submission order. Files are deduplicated by path; `Temporary` is `!step.Keep`, and `OutputID` comes from the job's outputs. The variables merge into the item. The cell is **done**.
  - any failed → the cell is **failed**, with the first failed job's error and the message "1 of 3 jobs failed".
  - else any cancelled → **cancelled**.
- **A job of a finished cell going back to queued** (a retry from the tray) puts the cell back to **running** and its blocked successors back to **pending**.
- **The item label** follows the job title when the item's input is a link and its first step is `downloader`.
- **A `StepOutputs` error** fails the cell with `CodeInternal` "Couldn't read what <tool> made".

### 8.3 Run status
- **The status is recomputed** after each change:
  - `cancelled` if the user cancelled;
  - otherwise, once every cell is in a final state (done/failed/cancelled/skipped/blocked/merged/none): `done`, `partial` or `failed`;
  - otherwise `waiting` if `NeedsYou > 0`, else `running`.
- **An item succeeded** when none of its cells is failed, cancelled or blocked.
- **A run that becomes `done`** cleans up its temporary files (§8.7).
- **Preflight at `StartRun`.** The run is refused with an `AppError` when:
  - there are no inputs, or more than 200 ("At most 200 files per run");
  - the pipeline isn't `Ready` (hint "Fix the problems in the pipeline first");
  - any `Missing` dep (message "Needs <names>", hint "Install them in Settings → Tool packs");
  - a secret is missing;
  - no input is accepted by any input step.
- **Inputs no input step accepts** are left out of the run, and listed in the run's `Error` as a note.

### 8.4 Manual steps ("I'll do this step myself")
1. **The cell becomes `waiting`** (`WaitManual`) with its `Inputs`. The toast (§11.7) offers "Open <tool>".
2. **Adoption.** The observer sees each job the first time it appears. An untagged job is adopted (`Jobs.Tag(id, run, step)`) and appended to the cell's `JobIDs` when:
   - its module is the step's module, and
   - its inputs share a path with a cell that is waiting for that step.
   A job matching several cells goes to the oldest run's first matching cell.
3. **AutoContinue on:** when an adopted job finishes **done with at least one output** and no other adopted job of the cell is active, the cell continues with those outputs.
4. **Continue (button):**
   - The cell's files are the outputs of every adopted done job, or the subset in `Keep`.
   - With no adopted outputs, the UI offers "Continue with the original file", which sends `PassThrough`.
5. **Skip step** carries the inputs on unchanged.
6. **Adopted jobs** keep their normal behaviour: tray, logs, retry. A failed adopted job doesn't fail the cell, because you can run the tool again.

**Defaults:**
- `AutoContinue` defaults to **on**, except for tools whose view makes several jobs per task: subtitles, lyric-video, visualizer and pdf.
- The editor sets it when Manual is switched on; it is stored per step.

### 8.5 Check steps
- **The cell waits** (`WaitCheck`) with its `Inputs`.
- **`Continue{Keep}`** sets `Files` to the kept subset, in order. An empty subset makes the cell **done**, and later cells **skipped** ("You kept nothing").
- **`SkipStep`** keeps everything.

### 8.6 Condition waits
- An adapter returning `CodeWaiting` puts the cell in `waiting` with `WaitCondition` and the message. The loop re-prepares it every 5 s, and immediately on `Retry`.
- Condition waits don't count in `NeedsYou` and don't make the run `waiting`.
- The run card still shows them: "Waiting: Unlock the Vault to continue".

### 8.7 Cancel, retry, restart and clean-up
- **Cancel run:**
  - cancels every active job of the run (`Jobs.Cancel`);
  - waiting, preparing and pending cells become cancelled or blocked;
  - the status becomes `cancelled`.
- **StopItem** does the same for one item.
- **Retry run:**
  - every failed or cancelled cell with jobs → `Jobs.Retry` of its failed or cancelled jobs;
  - cells without jobs (a prepare or submit error) → pending;
  - blocked → pending;
  - the status goes back to running.
  - Refused when the run is `Cleaned` ("Its in-between files were deleted; start it again").
- **Restart:**
  - `Start` loads the runs that were `running` or `waiting` and reconciles each cell with its jobs (`Jobs.Get`).
  - The job manager has already marked interrupted jobs failed, so their cells fail and **Retry** resumes them.
  - Queued jobs run again by themselves.
  - Preparing cells re-prepare.
  - Secrets are gone: a pending cell that needs one fails with "Passwords aren't kept after a restart" and the hint "Start the run again".
- **Clean-up** deletes files that are all of these:
  - `Temporary`;
  - registered outputs of this run's jobs;
  - inside the Library folder;
  - not also listed in a non-temporary cell's `Files`.

  It deletes the file and the Library record (`OutputStore.DeleteOutput`, emitting `library:removed`). Run inputs are never deleted.
- **When clean-up runs:**
  - automatically when a run ends `done`;
  - by **CleanUp** (the run's "Delete in-between files" button);
  - and by **Remove** with `deleteTemporary`.
  - `partial`, `failed` and `cancelled` runs keep their files until then, so Retry still works.
- **History:**
  - at most 200 finished runs, the oldest pruned at `Start` (their jobs stay);
  - a run's persisted state is ≤ 16 MiB (beyond that, values of variables are truncated first).
- **Limits:**
  - ≤ 2,000 jobs per run; past that, the cell fails with "This run is too big";
  - ≤ 1,000 files per cell.

### 8.8 Describe (validation)
For each step, in order:
1. **The type exists.**
   - An unknown type, or a module that isn't ready, is a problem: "<Tool> isn't available".
   - Manual is set but the type can't be manual, or Manual is off but it can't be automatic: that is a problem too.
2. **Options** (automatic steps): `DescribeStep(options)`. An error is the step's problem, using its message.
3. **`From` and the filter:**
   - `From` must be `input`, `none` (only with `NoFiles`), or an **earlier** step's ID.
   - The filter's roles must exist among the source's `Produces` (a warning, not a problem).
4. **What the source makes** (`Produces`, resolved):
   - a product with `Kind`/`Exts` "same" takes those of the source's own source, recursively;
   - the run's inputs count as everything the step accepts.

   If no resolved product (after the filter) matches the step's `Accepts`, it's a problem: "<Tool> can't read what step N makes (.mp3)". URLs count only for `input`.
5. **`{vars}`:** for every option at `Templates`, each name used must be a built-in or a variable of an **earlier** step. Otherwise it's a problem: "{bpm} isn't made by an earlier step".
6. **Steps after a together step** may still read from steps before it (the merged union).
7. **Keep:** a step whose files no later step reads, and that isn't the last step, still has `Keep` honoured. No implicit rule.

Pipeline-level problems:
- an empty or duplicate name;
- 0 or more than 30 steps;
- options over 1 MiB in total;
- watch folder problems (§8.9);
- a watched pipeline that needs secrets ("A watched pipeline can't ask for passwords").

`Missing` lists the `Requires` deps of the step modules that `Tools` can't resolve.

### 8.9 Watch folders (`core/pipeline/watch.go`)
- **Polling:** a single ticker, every 5 s, over pipelines with `Watch.Enabled` that are `Ready`. Others report `WatchState.Message`: "Fix the problems first", or "Folder not found".
- **Which files count:**
  - regular files at the top level, not hidden (`.` prefix, or the Windows hidden attribute);
  - not temporary (`~$*`, `*.part`, `*.crdownload`, `*.tmp`, `*.download`);
  - matching the pipeline's `Check.Accepts` extensions.
- **When a file is ready:** it is unchanged in size and mtime since the previous poll, and its mtime is at least 3 s old.
- **New files** are those not in `pipeline_watch_seen` with the same size and mtime. Those found in one poll start **one** run (`trigger: "watch"`), with up to 200 files; the rest wait for the next poll. Each is recorded as seen.
- **Baseline:**
  - enabling a watch, or changing its folder, records the files already there as seen, without running them;
  - files that appeared while Toolbox was closed are new, and run at the next start.
- **Folder rules** (checked in Describe):
  - absolute;
  - exists and is a directory;
  - not the Library folder or inside it;
  - not inside the support or tools directory.
- **Seen table:** rows of deleted pipelines are deleted with the pipeline. Rows of files that no longer exist are pruned at `Start`.

---

## 9. Storage, events and services

### 9.1 Store (`core/store`, migration `0005_pipelines.sql`)

```sql
ALTER TABLE jobs ADD COLUMN pipeline_run_id TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN pipeline_step_id TEXT NOT NULL DEFAULT '';
CREATE INDEX jobs_pipeline_idx ON jobs(pipeline_run_id) WHERE pipeline_run_id <> '';

CREATE TABLE pipelines (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  definition TEXT NOT NULL,          -- the Pipeline as JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pipeline_runs (
  id          TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,         -- no FK: runs outlive their pipeline
  status      TEXT NOT NULL,
  state       TEXT NOT NULL,         -- the PipelineRun as JSON, full variable values included
  created_at  INTEGER NOT NULL,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pipeline_runs_created_idx ON pipeline_runs(created_at DESC);
CREATE INDEX pipeline_runs_status_idx  ON pipeline_runs(status);

CREATE TABLE pipeline_watch_seen (
  pipeline_id TEXT NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  PRIMARY KEY (pipeline_id, path)
);
```

**`core.PipelineStore`** (`core/interfaces.go`):

```go
type PipelineStore interface {
	ListPipelines(ctx context.Context) ([]Pipeline, error)
	PutPipeline(ctx context.Context, p Pipeline) error // insert or replace
	DeletePipeline(ctx context.Context, id string) error // also its watch_seen rows
	PutRun(ctx context.Context, run PipelineRun, stateJSON string) error
	GetRun(ctx context.Context, id string) (stateJSON string, err error) // CodeNotFound
	ListRuns(ctx context.Context, f RunFilter) ([]string, error)         // state JSONs, newest first
	DeleteRuns(ctx context.Context, ids []string) error
	PruneRuns(ctx context.Context, keepFinished int) ([]string, error)
	SeenFiles(ctx context.Context, pipelineID string) (map[string]SeenFile, error)
	MarkSeen(ctx context.Context, pipelineID string, files []SeenFile) error
	ForgetSeen(ctx context.Context, pipelineID string, paths []string) error
}

type SeenFile struct {
	Path  string
	Size  int64
	MTime int64
}
```

**Other store changes:**
- `JobStore` reads and writes the two new job columns.
- `OutputStore` gains `MoveOutput(ctx, id, newPath string) (Output, error)`, which updates the path and name and keeps the ID and tags.

### 9.2 Jobs (`core/jobs.go`)

```go
type PipelineTag struct{ RunID, StepID string }

// SubmitFor is Submit with a pipeline tag on every job it creates.
func (m *Jobs) SubmitFor(ctx context.Context, moduleID string, inputs []string, optionsJSON string, tag PipelineTag) ([]Job, error)

// Tag sets the pipeline tag of an active or finished job (manual-step adoption).
func (m *Jobs) Tag(id string, tag PipelineTag) error

// Observe calls fn with every job snapshot after it is persisted (submit,
// start, progress-free updates, finish, retry, cancel). fn must not block.
// Returns a function that removes the observer.
func (m *Jobs) Observe(fn func(Job)) (stop func())
```

- **`Submit`** becomes `SubmitFor` with an empty tag.
- **Throttled progress** isn't sent to observers; only `publish` snapshots are.
- **`JobFilter`** gains `PipelineRunID string \`json:"pipelineRunId"\``.

### 9.3 Service (`modules/pipelines/service.go`, bound as `PipelinesService`)

```go
func (s *Service) List() []core.PipelineEntry
func (s *Service) Catalog() []core.StepType
func (s *Service) Templates() []core.PipelineTemplate
func (s *Service) Describe(p core.Pipeline) core.PipelineCheck
func (s *Service) Save(p core.Pipeline) (core.PipelineEntry, error) // ID "" = create
func (s *Service) Delete(id string) error
func (s *Service) Duplicate(id string) (core.PipelineEntry, error)  // "<name> copy"
func (s *Service) FromTemplate(templateID string) (core.Pipeline, error) // unsaved copy with fresh IDs
func (s *Service) Start(req core.RunRequest) (core.PipelineRun, error)
func (s *Service) Runs(f core.RunFilter) ([]core.PipelineRun, error)
func (s *Service) Run(id string) (core.PipelineRun, error)
func (s *Service) Cancel(runID string) error
func (s *Service) Retry(runID string) (core.PipelineRun, error)
func (s *Service) Continue(req core.ContinueRequest) error
func (s *Service) SkipStep(runID string, item int, stepID string) error
func (s *Service) StopItem(runID string, item int) error
func (s *Service) CleanUp(runID string) (int, error)
func (s *Service) Remove(runID string, deleteTemporary bool) error
// StepShape methods for the built-ins (bindings only): RenameShape, ChatShape, TableShape, ZipShape, CopyShape.
```

**`api/files.go`** gains `PickFolder(title string) (string, error)` (Wails directory dialog; "" when cancelled). It is used by the watch folder and Copy to folder.

**Events** are registered in `api/events.go`, typed in the bindings: `pipelines:changed`, `pipelines:run`, `pipelines:runs-removed`.

### 9.4 Wiring (`main.go`)
1. `runner := pipeline.New(...)` after `jobs`.
2. `pipelines.Register(reg, runner, chatSvc, db, libraryDir)` registers the module and the built-in step types.
3. `runner.Start(ctx)` right after `jobs.Start(ctx)`.
4. `runner.OnNeedsYou(shell.SetPipelinesNeedYou)`.
5. `defer runner.Stop()`.
6. Every module implementing `core.Chainable` is found through the registry; no extra wiring.

---

## 10. Built-in templates (`modules/pipelines/templates.go`)

**Template rules:**
- Templates are Go data. `FromTemplate` copies one with fresh step IDs and the name "<template name>". If the name is taken, it gets " 2", " 3", and so on.
- The **frontend** fills `showJson` for any visualizer step whose `presetId` is set and `showJson` is empty, from `viz/presets` (§11.3), before the first Save.
- Each template's `Packs` lists the packs it needs. The gallery shows them, with "Install" when missing (the existing packs flow).
- A Go test checks that every template passes `Describe` with all tools present, except for the visualizer `showJson` (filled by a fixture in the test).

| # | ID / name | Steps (`From` is the previous step unless noted; **K** = Keep) |
|---|---|---|
| 1 | `social-clip` · Clip for social | 1. downloader (video, ≤ 1080p) → 2. trimmer **manual** (note "Pick the part to keep, then Export") → 3. trimmer (whole, precise, 9:16, centre crop, ≤ 1080p) → 4. subtitles (small, burn, style boxed, size l, ≤ 50 MB) **K** |
| 2 | `podcast` · Podcast | 1. audio-cleanup (podcast) **K** → 2. transcribe (small, txt + srt) **K** → 3. pipelines.chat write (prompt below, `{transcript_timed}`, "{item} (show notes)", md) **K** |
| 3 | `sampling` · Sampling | 1. downloader (audio, FLAC) → 2. stems (four-fast, FLAC) → 3. bpm-key (From step 1) → 4. pipelines.rename (From step 2, `{name} · {bpm} BPM · {key}`) **K** → 5. audio-to-midi (From step 4, filter role `bass`, range bass) **K** |
| 4 | `karaoke` · Karaoke | 1. stems (vocals-fast, FLAC, From input) **K** → 2. lyric-video (From input; audio instrumental, karaoke on, title `{item}`) **K** |
| 5 | `product-photos` · Product photos | 1. bg-remover (balanced, on colour #ffffff, crop, padding 48) → 2. upscaler (photo, 2×) → 3. converter (webp, ≤ 1440, metadata off) **K** |
| 6 | `paper-archive` · Paper to archive | 1. pdf images-to-pdf (A4, small margin; together) → 2. ocr (searchable) → 3. pdf compress (balanced) → 4. vault (folder "Documents") |
| 7 | `foreign-video` · Foreign-language video | 1. downloader (video, ≤ 1080p) → 2. subtitles (turbo, translate to English, save srt, burn classic) **K** |
| 8 | `receipts` · Receipts | 1. ocr (text) → 2. pipelines.chat extract (fields date/date, merchant/text, total/number, currency/text; prompt below) → 3. pipelines.table (columns Date `{date_1}`… see below) **K** |
| 9 | `lecture` · Lecture | 1. transcribe (small, txt + srt) **K** → 2. pipelines.chat write (study notes + 10 flashcards, md) **K** |
| 10 | `before-sharing` · Before sharing | 1. redact (faces + plates, blur, strip metadata) → 2. pipelines.check (note "Check every face and plate is hidden") → 3. pipelines.zip (together, "{pipeline} {date}") **K** |
| 11 | `music-video` · Music video | 1. visualizer (preset `golden-hour`, full, 9:16, 1080, 30 fps, stems on, words none, mood on) **K** |

**Notes on the templates:**
- **Receipts:** the extract fields are named `when`, `merchant`, `total` and `currency`, because `{date}` is a built-in. The table columns are: File `{item}`, Date `{when}`, Merchant `{merchant}`, Total `{total}`, Currency `{currency}`.
- **Before sharing:** Redact's metadata strip covers "strip location" for images and videos, so there is no separate EXIF step.

**Prompts** (in `templates.go`, editable after copying):
- **Podcast:** "You are writing show notes for a podcast episode. From the transcript below, write in Markdown: a one-paragraph **Summary**; **Show notes** as 5–10 bullet points; **Chapters** as a list of `[h:mm:ss] Title` using the timestamps in the transcript. Transcript:\n\n{transcript_timed}"
- **Lecture:** "From this lecture transcript, write Markdown study notes: the key ideas as headed sections with bullet points, a short glossary of terms, then 10 **flashcards** as `Q:`/`A:` pairs. Transcript:\n\n{transcript}"
- **Receipts:** "Read this receipt text and extract the purchase date (YYYY-MM-DD), the merchant's name, the total paid as a number, and the currency code. Text:\n\n{text}"

---

## 11. UI

### 11.1 Sidebar and routing
- **Sidebar:** `nav.ts` adds `PIPELINES_ITEM = {id: "pipelines", label: "Pipelines", icon: "workflow"}` right after Recent, and filters `pipelines` out of the tools group. `Mod+1` is Recent and `Mod+2` is Pipelines, then the tools follow.
- **Badge:** the item shows a badge with the number of cells that need you, plus the running dot while any run is active.
- **Route:** `toolViews["pipelines"]` → `tools/pipelines/PipelinesView.tsx`.

### 11.2 Pipelines page

```
┌ Pipelines ───────────────────────────────────────── [Pipelines | Runs (2)] [+ New] ┐
│ ┌───────────────────────┐ ┌────────────────────────────────────────────────────────┐│
│ │ ▣ Clip for social   ▶ │ │ Clip for social                         [Run…]  [⋯]   ││
│ │   ⇩ ✂ ✂ CC  · links   │ │ Takes: links            ● Ready                       ││
│ │ ▣ Podcast           ▶ │ │ ① ⇩ Downloader      Video · up to 1080p        [⋯]     ││
│ │   ✧ ≋ ✦  · watching   │ │ ② ✂ Video Trimmer   I'll do this myself        [⋯]     ││
│ │ ▣ Receipts          ▶ │ │ ③ ✂ Video Trimmer   Whole · 9:16 · precise     [⋯]     ││
│ │ …                     │ │ ④ CC Subtitles      Burn · boxed · ≤ 50 MB  ▣K  [⋯]     ││
│ │                       │ │        [+ Add step]                                    ││
│ │ (drop files on a card │ │ Triggers  ☐ Watch a folder   [Choose…]                 ││
│ │  to run it)           │ │ Run history: 3 runs · last: done 10 min ago  → Runs    ││
│ └───────────────────────┘ └────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Left: the pipeline list.**
- Each card shows the name, the step icons in order, what it takes ("files"/"links"), a watch indicator, a ▶ Run button and a status dot (ready, problems, missing tools).
- **Each card is a drop target** with id `pipeline-drop:<id>` (§11.6).
- **Empty state:** "No pipelines yet", with **New pipeline** and a strip of four template cards (Clip for social, Podcast, Sampling, Product photos), plus "All templates…".

**+ New** opens the **template gallery** (a dialog):
- a "Blank pipeline" card, plus the 11 templates;
- each shows its icon, name, blurb, step icons and a "Needs: Music pack" chip, with Install where missing;
- choosing one → `FromTemplate` (or a blank pipeline with one Downloader step reading `input`) → fill the visualizer designs → `Save` → select it.

**Right: the editor** for the selected pipeline.
- **Header:**
  - the name, editable inline;
  - an optional description;
  - **Run…**;
  - a ⋯ menu: Duplicate, Delete (with a confirm that names any active runs, which keep going).
- **"Takes:"** comes from `Check.Accepts`, e.g. "audio & video files", "links", or "images & PDFs".
- **Autosave:** edits save automatically, debounced 600 ms (`Save`), with a "Saved" or "Couldn't save: …" indicator.
- **Describe** runs debounced 250 ms after each edit. Its problems show on the step they belong to, and above the steps for the pipeline-level ones. Run is disabled with the first problem as its tooltip.
- **Step list:**
  - a vertical list of **step cards** (§11.4); a drag handle or Alt+↑/↓ moves a step;
  - **+ Add step** appears at the end and on hover between cards.
- **Triggers:**
  - **Watch a folder:** a switch, the folder path, **Choose…** (`FilesService.PickFolder`), and the `WatchState` message.
  - The line "Also: drop files on this pipeline, Library → Send to, or the command palette".
- **Run history:** the count and last status, with a link to the Runs tab filtered to this pipeline.

### 11.3 Add-step menu
A popover with search, grouped by category, built from `Catalog()`.

**Built-ins come first, under "Pipeline steps":**
- Check
- Rename files
- Ask Local Chat
- Make a table
- Zip
- Copy to folder

**Compatibility:**
- Each tool shows whether it can read what's available at that point. The FE computes this from the resolved `Produces` of the earlier steps (`StepCheck.Info.Produces`) against the type's `Accepts`, in `pipelines/compat.ts`.
- **Compatible tools are listed first.** The others are dimmed, with the reason, e.g. "Reads images; nothing earlier makes images". They can still be added, reading from `input`.

**Defaults for a new step:**
- `From` is the nearest earlier step whose products it can read, else `input`, else `none` for `NoFiles` types.
- Its options are the type's `DefaultsJSON`.
- `Manual` is on for types that can only be manual, like Object Eraser.
- `Keep` is on if it is the new last step. The previous last step's `Keep` is switched off unless the user had set it.

**Visualizer steps:** picking one opens its editor straight away on the design choice. `presetId` and `showJson` come from `viz/presets` (`presetById(id).show`, serialised as the Visualizer does) or from **My designs** (`VisualizerService.Designs`).

### 11.4 Step cards and step editors
**Collapsed:**
- the number, icon, label (or type name), and `Info.Summary`;
- chips:
  - "from step 2 · Bass only" when the source isn't the previous step or there's a filter;
  - "I'll do this myself";
  - "Kept" (or "In-between" when Keep is off);
  - ⚠ with the problem count.

**Expanded (click),** top to bottom:
1. **Files from:** a select listing "The files you run it on", each earlier step ("Step 2 · Stem Splitter"), and "No files" (`NoFiles` types). Then **Only:** chips for the source's roles (resolved products), plus "More filters…": kinds, extensions and a name contains field.
2. **How:**
   - **Automatically** or **I'll do it myself in <Tool>** (where both are possible).
   - With manual on: a switch "Continue when <Tool> finishes" (AutoContinue), plus a Note field.
   - Manual steps show no option editor, just "The tool opens with the file loaded and uses its own settings".
3. **Options:** the type's **step editor** (below).
4. **Keep its files in the Library:** a switch, with help "Off: deleted when the run finishes without problems".
5. **Footer:** Label override, Duplicate, Remove.

**Step editors:** `frontend/src/pipelines/steps/`.

```ts
// registry.ts (Wave 0, frozen)
export interface StepEditorProps<T> {
  value: T;
  onChange: (next: T) => void;
  check: StepCheck | undefined; // problems, info, available vars
  vars: StepVar[];              // shorthand for check?.vars ?? built-ins
}
export interface StepUI<T = unknown> {
  type: string;                         // StepType.ID
  parse: (optionsJson: string) => T;    // sanitize over the defaults (never throws)
  Editor: ComponentType<StepEditorProps<T>>;
}
export function registerSteps(list: StepUI<never>[]): void; // called by the group files
export function stepUI(type: string): StepUI | undefined;
```

- **Group files:**
  - `steps/media.tsx` (AD1's tools)
  - `steps/compound.tsx` (AD2)
  - `steps/docs.tsx` (AD3)
  - `steps/builtin.tsx` (BI1)
  - `steps/index.ts` (Wave 0) imports all four.
- **What editors reuse:**
  - each tool's `DEFAULT_*`/`sanitize*` helpers;
  - the existing panels where they exist: Downloader `OptionsPanel` (trim fields hidden), Redact `OptionsPanel` with `part="all"`;
  - `components/` primitives.
- **Subsets:** editors show the step options' fields only. Fields that need a specific file, like trim segments, aren't there.
- **Unknown types** render "This step can't be edited here" with a raw summary (never crash).
- **Vitest:** a test asserts every type in a fixture `Catalog()` snapshot that is `Auto` has a `StepUI`.

**`components/TemplateField.tsx`** (Wave 0, final):
- a text input or textarea (`multiline`) that highlights `{vars}` and marks unknown ones in red;
- typing `{` opens a variable list (the `vars` prop, labels shown);
- an **Insert variable** menu button;
- props: `{value, onChange, vars, multiline?, placeholder?, label, error?}`.

**`pipelines/vars.ts`** (Wave 0) has `templateVars(tpl)` and `expandPreview(tpl, sample)`, mirroring `core.TemplateVars`/`ExpandVars`, with shared test vectors in `testdata/vars.json` read by both test suites.

### 11.5 Run sheet and the Runs tab
**Run sheet** (a dialog opened by Run…, a card's ▶, the palette, Send to, or the drop chooser).
- **Inputs:**
  - a `DropZone` (id `pipeline-run:<id>`) plus **Choose files** (`FilesService.PickWith(title, Check.Accepts.extensions, true)`);
  - a **Links** textarea when `Accepts.urls`;
  - the list of inputs, with unaccepted ones struck through ("not for this pipeline").
- **Secrets:** a password field for each `Check.Secrets` entry, labelled "Step 3 · PDF password".
- **Start:** `Start` closes the sheet and switches to the Runs tab on the new run. Errors show inline.

**Runs tab:**
- **Left: the runs list**, active first, then newest. Each row has the pipeline name, the status chip, "3 of 5 files", the time, and a "Needs you" badge. There is a filter for one pipeline or all.
- **Right: the run detail.**
  - **Header:** name, status, started (relative), trigger, and actions: **Cancel** (active), **Retry failed** (partial/failed/cancelled, not Cleaned), **Delete in-between files** (finished with temporary files left), **Remove** (finished; its confirm has a checkbox "Also delete in-between files", on by default).
  - **Needs you:** one card per waiting cell (manual/check) of this run (§11.7).
  - **Grid:**
    - rows are items, with their label; merged items are labelled "All N files" and sit under the items they gather;
    - columns are steps, with an icon and number;
    - each cell shows a status icon (spinner with job progress, check, ✕, ⏸, –, ⤵ merged).
  - **Clicking a cell** opens a popover with:
    - its message or error, with the hint;
    - its jobs, each with status and **Show log** (opens the job tray with that job's log expanded: `setExpandedLogJobId`);
    - its files, each with Open, Reveal and Send to;
    - the variables it made (previews).
  - **Results:** the files of every Keep step's cells, grouped by item, with Open/Reveal, **Open folder** (for built-ins, `Pipelines/<name>/`), and the variables of each item in a small table (bpm, key…).

### 11.6 Triggers in the shell
**Drops** (`shell/dropRouting.ts`):
- `targetId` `pipeline-drop:<id>`: if the pipeline is Ready, needs no secrets and accepts at least one path, `Start` right away and toast "Started <name> with 3 files" (action "Show"). Otherwise open the Run sheet with the paths.
- `targetId` `pipeline-run:<id>`: add the paths to the open Run sheet.
- **The global chooser** (`DropOverlay`) gets a **Pipelines** section under the tools: every pipeline whose `Check.Accepts` takes at least one path, opening the Run sheet with them.

**Library → Send to:** after the tools, a separator and "Pipeline: <name>" for each pipeline accepting the file → the Run sheet.

**Command palette** (block in `useBuiltinCommands.ts`):
- "Open Pipelines"
- "New pipeline…"
- "Run pipeline: <name>" for each pipeline (opens the Run sheet)
- "Show pipeline runs"

**Job tray** (`JobRow`): jobs with `pipelineRunId` show a chip "⛓ <run name> · <step n>/<N>". Clicking it navigates to Pipelines → Runs → that run.

### 11.7 "Needs you"
**The card** (`NeedsYouCard`, on the Runs tab):
- Title: "<run name> · <item label>"; subtitle: the step's label and its Note.
- **Manual:**
  - the input files;
  - the adopted jobs so far ("Made in Video Trimmer: clip (trim).mp4");
  - buttons: **Open <Tool>** (`handOff({moduleId, inputs: cell input paths})`), **Continue** (disabled until an adopted job is done, with "Continue with the original file" as a secondary link), **Skip step**, **Stop this file**.
- **Check:**
  - each input file with a thumbnail (images: `ImageThumb`; others: a kind tile) and a checkbox (all on);
  - buttons: Open, Reveal, **Continue with N files**, **Stop this file**.

**Banner** (`shell/PipelineBanner.tsx`, rendered by `Shell.tsx` above the tool view):
- Shows when the current view is a module with a waiting manual cell: "Clip for social is waiting: Pick the part to keep, then Export".
- Buttons: **Continue** (as the card), **Skip step**, **Show run**.
- With several waiting cells for that tool, it says "2 pipeline steps are waiting" and **Show** goes to the Runs tab.
- It is a thin bar in tokens' accent colour and never covers the tool's own controls.

**Toast:** when a cell starts waiting (manual or check), the FE toasts "<run name> needs you", with the step label as its description. The action is "Open <Tool>" (manual) or "Check files" (check). Duration 0 if the main window isn't focused, 8 s otherwise.

**Tray** (`desktop`): `Shell.SetPipelinesNeedYou(total, firstRunName)` adds a menu item at the top, "<firstRunName> needs you" (or "N pipeline steps need you"). It opens the main window on Pipelines → Runs, and is removed at 0.

### 11.8 State (`frontend/src/state/pipelines.ts`, Wave 0)
- A Zustand store:
  - `entries` (from `List` + `pipelines:changed`);
  - `catalog` and `templates` (loaded once);
  - `runs` by ID (from `Runs({limit: 50})` + `pipelines:run`, merged);
  - `selectedPipelineId`, `selectedRunId`, `tab` ("pipelines" | "runs");
  - `runSheet: {pipelineId, inputs} | null`.
- **Selectors:** `useNeedsYou()` (cells waiting with manual/check across runs, stable via `useMemo` on the runs map), `useWaitingForModule(moduleId)`, `useRunName(runId)`.
- **Actions:** `openRunSheet(pipelineId, inputs?)`, `showRun(runId)`, plus thin wrappers over the service.
- **Bootstrap:** `bootstrap.ts` loads the entries and active runs at start, so the banner, badge and chips work before the page is opened.

---

## 12. Foundation (Wave 0, architect, committed to main before builders start)

1. **Archive and roadmap:** P7's spec archived to `docs/specs/phase-7.md` (done); `docs/ROADMAP.md` points Phase 7 at it.
2. **`core`:**
   - `pipeline_types.go` (§5) and `steps.go` (§6.1) with `ExpandVars`/`TemplateVars`/`FileVars` **implemented and tested** against `testdata/vars.json`;
   - `CodeWaiting`/`ErrWaiting`;
   - the `Job` fields;
   - the events;
   - `PipelineStore`, `OutputStore.MoveOutput`;
   - `TextGenerator.ContextTokens` (chat implements it; the fakes in tests too).
3. **`core/jobs.go`:** `SubmitFor`, `Tag`, `Observe` and the `JobFilter` field, implemented with tests.
4. **`core/store`:** migration 0005, the job columns, `PipelineStore` and `MoveOutput`, implemented with tests.
5. **`core/pipeline`:** the package with `Config`, `New` and every method signature from §8. The bodies are stubs: `Catalog` and `Describe` work for type lookup only; the rest return `CodeInternal` "not implemented". `fake_test.go` provides a fake Chainable module for PR1.
6. **`modules/pipelines`:**
   - the module (descriptor, `Options`, the five StepOptions types);
   - `Register`;
   - a `Service` with every method from §9.3 delegating to the runner, including the shape methods;
   - `templates.go` with the IDs and names only (BI1 fills in the steps).
7. **Every adapter module:**
   - `pipeline.go` with its final `StepOptions` type (where new) and a `Chainable` implementation whose `DescribeStep` returns the static Accepts/Produces/Vars of §6.2 and whose `PrepareStep`/`StepOutputs` return "not implemented";
   - the new action constants and option fields (§6.3, §6.4) with `Validate` rejecting `auto` as "not implemented yet";
   - the `StepShape()` service methods.
8. **API and wiring:**
   - `api/files.go` `PickFolder`;
   - the events in `api/events.go`;
   - the `main.go` wiring (§9.4);
   - the desktop `SetPipelinesNeedYou` (tray item).
9. **Bindings** regenerated; `lib/api.ts` re-exports.
10. **Frontend skeleton:**
    - `state/pipelines.ts` (complete) and the bootstrap;
    - `nav.ts` item;
    - `tools/pipelines/PipelinesView.tsx` with the tab layout mounting `PipelineList`, `PipelineEditor`, `RunsPanel` and `RunSheet` stubs;
    - `pipelines/steps/registry.ts` + `index.ts` + the four empty group files;
    - `pipelines/vars.ts`, `pipelines/compat.ts` (with tests);
    - `components/TemplateField.tsx` (complete);
    - the toolViews line.
11. **Docs:** a Phase 8 section in `CLAUDE.md` (§16); `docs/MAC-CHECKLIST.md` Phase 8 steps (§13.5).

---

## 13. Test plan

### 13.1 Go (stdlib `testing`, table tests, fakes)
**`core`:**
- `ExpandVars`, `TemplateVars` and `FileVars` (the shared vectors, including braces, unknown names and the caps);
- `Jobs.SubmitFor`/`Tag`/`Observe`: snapshots arrive, the tag persists across Retry, observers can stop.

**`core/store`:**
- migration 0005 on a Phase 7 DB;
- the round trips (pipelines, runs, seen, `MoveOutput` keeps ID and tags);
- `PruneRuns`.

**`core/pipeline` (PR1),** with a fake registry of fake Chainable modules that make files in a temp library (they can fail, wait, make several files or none, set variables, take secrets):
- linear 3 steps on 3 items; per-item order; the in-flight cap;
- fan-out (one item → 4 files) and filter by role;
- `From` an earlier step (branching);
- together: merge, a together step reading a pre-merge step, items that fail before the merge being left out, a late retry being `skipped`;
- variables: accumulation, override, unknown names, table rows from each item's variables;
- manual: adoption by module and path, AutoContinue only on done-with-files, Continue with Keep, PassThrough, Skip, StopItem;
- check: keep a subset, keep none;
- condition wait: re-prepared until it clears;
- cancel run; retry run (failed job retried with the same ID, prepare errors re-prepared, blocked → pending); retry from the job tray resuming the item;
- restart: a persisted running run with an interrupted job, a queued job, a preparing cell and a lost secret;
- clean-up: only temporary files of the run inside the Library, never inputs, record removed;
- Describe: every rule in §8.8, with messages;
- watch: stability across two polls, temp/hidden ignored, baseline, one run per poll, folder rules;
- preflight refusals;
- the status table.

**Adapters (AD1–AD3):** for each module, a table test of `DescribeStep` (summary, accepts, products, problems), `PrepareStep` (grouping, expansion, defaults filled, the trimmer segments from a fake probe), and `StepOutputs` from recorded `Job`s (roles, variables, pass-through for PDF compress).
- **Subtitles, Lyric Video and Visualizer `auto`:** `Run` against fakes (fake engine, fake TextGenerator, the fake render broker from P7 tests). Covered:
  - the order of the parts;
  - progress ranges;
  - the no-speech / no-lyrics errors;
  - outputs.

**Built-ins (BI1):**
- rename: move vs copy, illegal characters, collisions, roles kept, `MoveOutput` called;
- chat: write, extract (schema, retry once, unusable), chunking with a fake generator and a small `ContextTokens`;
- table: CSV quoting and BOM;
- zip: store vs deflate, duplicate names;
- copy: never overwrite, folder rules;
- templates: every template Describes Ready with a fake full registry.

**Integration** (`-tags integration`, real tools):
- `integration/pipeline_test.go`: converter → rename on a generated WAV → MP3 → `{name} · copy`;
- trimmer first-5-s on a generated video;
- PDF images-to-pdf → compress on generated PNGs;
- a manual step adopted from a direct `Jobs.Submit`.

### 13.2 Frontend (Vitest, jsdom)
- `vars.ts` (the shared vectors); `compat.ts`.
- `TemplateField`: highlighting, the `{` menu, insert.
- **Step editors:** each renders from defaults, edits round-trip through `parse`, and every `Auto` catalogue type has a `StepUI`.
- **Editor:**
  - add, remove and move steps;
  - the From and filter selects;
  - the manual toggle setting AutoContinue by tool;
  - Keep defaults on add;
  - problems shown on the right step;
  - autosave debounce;
  - the template gallery fills the visualizer design.
- **Run sheet:** accepted vs struck inputs, links, secrets, Start errors.
- **Runs:** grid statuses, the cell popover, Needs-you cards (manual/check actions call the right service), Retry/Clean/Remove states.
- **Shell:**
  - drop routing (instant start vs sheet);
  - the DropOverlay section;
  - Library Send to items;
  - palette commands;
  - the banner shown only for the waiting module;
  - the JobRow chip;
  - the sidebar badge.

### 13.3 End to end (architect, Wave 3)
Real runs in the dev sandbox on the Windows box, of templates 1, 2, 3, 5, 6, 8, 10 and 11 on real inputs, plus a watch-folder run. Details in §14 Wave 3.

### 13.4 Checks
`go vet`, `go test -race` (where cgo is available), gofmt, the darwin cross-vet, `npm run check`, `wails3 build`.

### 13.5 Mac checklist (new steps)
1. **Watch folder on APFS:** files copied in from Finder start one run after they settle.
2. **Manual step:** the Trimmer opened from a pipeline is adopted; the banner shows; AutoContinue carries on.
3. **The tray "needs you" item** opens the Runs tab.
4. **Template 11 (Visualizer)** renders with the window hidden in the tray.

---

## 14. Work packages

### Wave 0: foundation (architect)
§12, committed to main.

### Wave 1 (parallel)

| WP | Owns | Acceptance |
|---|---|---|
| **PR1 Runner** | `core/pipeline/**` (except the frozen `types`/signatures), its tests | §8 complete; §13.1 runner tests; Describe messages as written |
| **BI1 Built-in steps** | `modules/pipelines/**` (except the frozen `service.go` signatures and module descriptor), `frontend/src/pipelines/steps/builtin.tsx` | §7, §10; §13.1 built-ins; editors for the five built-ins + Check (note only) |
| **AD1 Media adapters** | `pipeline.go` (+ tests) of downloader, converter, trimmer, audiocleanup, redact, stems, bpmkey, midi, transcribe; converter image `MaxHeight` (+ its view's height control); `frontend/src/pipelines/steps/media.tsx` | §6.2–6.3 rows; §13.1 adapters; editors |
| **AD2 Compound actions** | subtitles, lyricvideo and visualizer: the `auto` actions in their run code + `pipeline.go` (+ tests); `frontend/src/pipelines/steps/compound.tsx` (the visualizer editor uses `viz/presets` and `VisualizerService.Designs`) | §6.4; §13.1; one real auto run of each |
| **AD3 Image and document adapters** | `pipeline.go` (+ tests) of pdf (secrets, grouping, pass-through), vault (wait), bgremove, upscale, exif, eraser (manual-only descriptor); `frontend/src/pipelines/steps/docs.tsx` | §6.2–6.3 rows; §13.1 |
| **UI1 Pipelines page** | `tools/pipelines/{PipelineList,PipelineEditor,StepCard,AddStepMenu,TemplateGallery,FiltersPopover}*` | §11.2–11.4; FE tests |

### Wave 2 (parallel, after Wave 1 merges)

| WP | Owns | Acceptance |
|---|---|---|
| **UI2 Runs and triggers** | `tools/pipelines/{RunSheet,RunsPanel,RunGrid,CellPopover,NeedsYouCard,RunResults}*`, `shell/PipelineBanner.tsx`, the pipelines parts of `shell/{dropRouting,DropOverlay,JobRow,Sidebar,Shell,useBuiltinCommands}` (marked blocks), `views/LibraryView.tsx` Send to | §11.5–11.7; FE tests |

UI2 waits for Wave 1 because it needs a working runner to be checked against the real app. It may start from the Wave 0 store and types if Wave 1 runs long.

### Wave 3: integration (architect)
1. Merge, regenerate the bindings, run every check and `wails3 build`.
2. **Real runs, in the sandbox:**
   1. **Clip for social** on a real link, with the manual trim through the Trimmer.
   2. **Podcast** on a 30-minute recording; chunking kicks in at an 8k context.
   3. **Sampling** on a real link: the stems are renamed with BPM and key, and MIDI is made from the bass only.
   4. **Product photos** on 5 photos.
   5. **Paper to archive** on 4 phone photos of pages, with the Vault locked first, then unlocked.
   6. **Receipts** on 5 receipt photos, giving a CSV.
   7. **Before sharing** on 3 photos and a video, with the check step.
   8. **Music video** with the window hidden.
3. **A watch folder** on `.dev/watch-in` (copy 3 files in, then 1 more later).
4. **Restart in the middle of a run**, then resume it with Retry.
5. **No listeners** beyond P5's; nothing written outside the repo, the sandbox and the user-chosen folders.
6. DECISIONS.md, ROADMAP, the Mac checklist and the summary.

---

## 15. Acceptance criteria

1. **Making:**
   - A pipeline of any listed step types can be built, reordered and saved.
   - Every built-in template opens Ready, when its packs are installed, with no edits.
   - Problems name the step and the cause in plain words.
2. **Data flow:**
   - **Fan-out:** the Sampling run makes MIDI from the bass stem only, and the stems carry the BPM and key in their names.
   - **Branching:** step 3 of Sampling reads step 1.
   - **Fan-in:** Paper to archive makes one searchable, compressed PDF from 4 photos, and Receipts one CSV with one row per photo.
3. **Variables:** `{bpm}`, `{key}`, `{title}`, `{transcript}`, `{transcript_timed}`, `{text}` and the extracted fields reach file names, prompts and columns. An unknown variable is a Describe problem.
4. **Manual and check:**
   - **Manual:** a manual Trimmer step opens the Trimmer with the file. The banner shows. The Trimmer's export is picked up, and the run continues without another click.
   - **Check:** a check step can drop a file, and the zip then leaves it out.
5. **Jobs:**
   - Every step's work shows in the job tray with the run chip and its log.
   - Cancelling the run stops its jobs.
   - Retrying a failed job from the tray resumes its item.
   - A restart in the middle is recoverable with Retry failed.
6. **Triggers:**
   - A drop on a ready pipeline starts it at once.
   - The drop chooser and Library Send to list matching pipelines.
   - The palette runs any pipeline.
   - A watch folder runs once per batch of settled files and never on files that were already there.
7. **Library:**
   - In-between files of a `done` run are deleted from disk and the Library.
   - Kept files stay.
   - Inputs are never touched.
   - Outputs of built-ins live in `Pipelines/<name>/`.
8. **Waiting conditions:** a locked Vault makes the step wait and continue by itself after unlocking. PDF passwords are asked at start and never stored.
9. **Speed:** the run overhead is ≤ 300 ms per cell over the jobs themselves (measured on the Converter → Rename run with 20 files).
10. **Housekeeping:**
    - all checks are clean (`go vet`, `go test`, gofmt, darwin cross-vet, `npm run check`);
    - the integration tests pass;
    - CLAUDE.md, the Mac checklist, ROADMAP and DECISIONS are updated.

## 16. CLAUDE.md additions (Wave 0)

A "Pipelines (Phase 8)" section:
- **A run isn't a job.** The `core/pipeline` Runner is one event loop that submits tagged jobs (`Jobs.SubmitFor`) and follows them with `Jobs.Observe`. Never block in an observer.
- **How to make a module a pipeline step:**
  - implement `core.Chainable` in `modules/<id>/pipeline.go`: `StepDefaults`, `DescribeStep` (Accepts/Produces with roles/Vars/Summary/Templates), `PrepareStep` (grouping; expand `{vars}` with `core.ExpandVars`) and `StepOutputs` (roles + variables);
  - add a `StepShape()` service method if its step options are a new type;
  - add its `StepUI` to a `frontend/src/pipelines/steps/*.tsx` group.
- **Manual steps** need nothing from a module. They adopt jobs by module and input path.
- **Secrets** (passwords) are asked at run start, live only in Runner memory, and are never in the DB or job options (only a `passwordRef`).
- **Temporary files:** clean-up only deletes the run's own registered outputs inside the Library, never inputs.

## 17. Risks
- **The chat model's quality on long transcripts.** Map-reduce notes lose detail, and an 8k context reads a 1-hour podcast in about 6 parts. Chapters depend on the model keeping the timestamps.
  - Mitigations: the map prompt says to keep the timestamps; the Podcast template uses `{transcript_timed}`; the user can raise the context size in Settings → Local Chat.
- **Adoption by path can pick up an unrelated job.** For example, the user runs the Trimmer on the same file for another reason while a manual step waits. The card lists what was picked up and Continue takes a subset, but AutoContinue would carry it on.
  - This is acceptable for a personal app; it's in the help text.
- **Watch folders over network drives or cloud folders** (iCloud, OneDrive placeholders) may report sizes before the content arrives. The 3-second and two-poll rules help, and placeholder files without local content fail their first step with a read error, which Retry fixes.
- **Template 1 encodes the video three times** (trim, crop, burn). Quality at 1080p stays acceptable at the bitrates Trimmer and Subtitles use, and the size cap is applied last.
- **Run state size:** 200 items × 30 steps with full transcripts could reach megabytes. Variables are stored once per item, previews on the wire are capped, the state is capped at 16 MiB, and `pipelines:run` is throttled.
- **Scope:** six Wave 1 packages touch many modules, but each module's change is one new file plus, for three of them, one new action. The adapters share one interface and one test pattern.
