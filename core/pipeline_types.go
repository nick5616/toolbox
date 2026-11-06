package core

// Pipeline wire types (SPEC.md §5). Times are Unix milliseconds.

// Pipeline is a saved chain of steps.
type Pipeline struct {
	ID          string         `json:"id"`          // ULID; "" when unsaved
	Name        string         `json:"name"`        // 1–80 chars, unique ignoring case
	Description string         `json:"description"` // ≤ 300 chars
	TemplateID  string         `json:"templateId"`  // the template it came from ("" = blank)
	Steps       []PipelineStep `json:"steps"`       // 1–30
	Watch       WatchConfig    `json:"watch"`
	Clip        ClipTrigger    `json:"clip"` // "When I copy…" (Phase 14)
	// Schedule starts runs at set times (Phase 18). Runs start with no
	// files, so only pipelines that read none can be scheduled.
	Schedule ScheduleTrigger `json:"schedule"`
	// Params are values asked for when a run starts (Phase 16): each is a
	// variable every step can use, and step options can be wired to it.
	Params []PipelineParam `json:"params"` // ≤ 20
	// Layout is the node editor's canvas state (Phase 10): JSON
	// {"v":1,"nodes":{"<stepId>|input":{"x":0,"y":0}},"view":{"x":0,"y":0,"zoom":1}}.
	// Opaque to the runner; ≤ 32 KiB; "" = auto layout.
	Layout    string `json:"layout"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// PipelineStep is one step of a pipeline.
type PipelineStep struct {
	ID           string     `json:"id"`          // 8 chars [a-z0-9], unique in the pipeline; not "input"/"none"
	Type         string     `json:"type"`        // StepType.ID
	Label        string     `json:"label"`       // optional title (≤ 60); "" = the type's name
	OptionsJSON  string     `json:"optionsJson"` // the type's step options; "{}" for manual and check steps
	From         string     `json:"from"`        // "input" | "none" | an earlier step's ID
	Filter       StepFilter `json:"filter"`
	Manual       bool       `json:"manual"`       // "I'll do this step myself"
	AutoContinue bool       `json:"autoContinue"` // manual: continue when an adopted job finishes with files
	Keep         bool       `json:"keep"`         // keep this step's files in the Library after the run
	Note         string     `json:"note"`         // manual/check: shown on the "needs you" card (≤ 200)
	// Binds wire option fields to variables (Phase 16): before the step is
	// prepared, the runner writes each variable's value into its field. An
	// empty or missing variable keeps the field's own value.
	Binds []StepBind `json:"binds"` // ≤ 50, one per option
}

// StepBind wires one option field of a step to a variable.
type StepBind struct {
	Option string `json:"option"` // JSON pointer to a string, number or boolean field of OptionsJSON, e.g. "/speed" or "/show/music"
	Var    string `json:"var"`    // a variable the step can use (a built-in, a run parameter or an earlier step's)
}

// ValueType is the type of a value on a pipeline port (Phase 16). It picks
// the port's colour and which wires may connect.
type ValueType string

const (
	ValueText   ValueType = "text"   // any text ("" means text too)
	ValueNumber ValueType = "number" // a decimal number
	ValueToggle ValueType = "toggle" // true/false (also yes/no, on/off, 1/0)
	ValueChoice ValueType = "choice" // one of a fixed set of words
	ValueColor  ValueType = "color"  // #rrggbb
	ValueFile   ValueType = "file"   // a path to one file
)

// PipelineParam is a value asked for when a run starts. Runs started by a
// watch folder or the clipboard use Default.
type PipelineParam struct {
	Name    string    `json:"name"`    // variable name, [a-z][a-z0-9_]{0,31}; not a built-in or step variable
	Label   string    `json:"label"`   // 1–60 chars
	Type    ValueType `json:"type"`    // never ValueFile
	Default string    `json:"default"` // ≤ 1000 chars
	Choices []string  `json:"choices"` // ValueChoice: 2–30 values
}

// ClipTrigger starts a run when something is copied while clipboard recording
// is on (Phase 14). Sensitive copies never reach it. A copied link becomes a
// URL input, an image its saved PNG, text a .txt file.
type ClipTrigger struct {
	Enabled bool     `json:"enabled"`
	Kinds   []string `json:"kinds"`   // ClipTriggerLink | ClipTriggerImage | ClipTriggerText; 1–3
	Pattern string   `json:"pattern"` // RE2 regular expression the text must contain a match for; required with "text"
}

// ScheduleTrigger starts a run at local clock times on chosen weekdays
// (Phase 18). It fires only while Toolbox runs; a slot missed while it was
// closed or asleep fires once on start/wake when it is within CatchUpMin.
type ScheduleTrigger struct {
	Enabled    bool     `json:"enabled"`
	Days       []int    `json:"days"`       // 0 = Sunday … 6; 1–7 unique values
	Times      []string `json:"times"`      // "HH:MM" 24 h local; 1–12 unique
	CatchUpMin int      `json:"catchUpMin"` // 0–720 (default 30)
}

// ScheduleState is a pipeline's schedule as listed.
type ScheduleState struct {
	Active  bool   `json:"active"`
	Message string `json:"message"` // "" = fine; else why not, or "Skipped 9:30: the last run is still going"
	Next    int64  `json:"next"`    // next fire, Unix ms; 0 = none
}

// Clipboard trigger kinds.
const (
	ClipTriggerLink  = "link"  // the copy is one http(s) link
	ClipTriggerImage = "image" // an image
	ClipTriggerText  = "text"  // any text matching Pattern (a link is text too)
)

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
	Accepts      Accepts  `json:"accepts"` // the widest it reads, over all options
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
	Name  string    `json:"name"`
	Label string    `json:"label"`
	Type  ValueType `json:"type,omitempty"` // "" = text (Phase 16)
}

type StepSecret struct {
	Key   string `json:"key"`   // unique within the step
	Label string `json:"label"` // "PDF password"
}

// PipelineCheck is Describe's answer for a whole pipeline.
type PipelineCheck struct {
	Steps    []StepCheck `json:"steps"`    // same order as the pipeline's
	Accepts  Accepts     `json:"accepts"`  // what a run takes: the union over steps with From "input"
	Problems []string    `json:"problems"` // pipeline-level: name, no steps, too many steps, watch folder
	Secrets  []SecretAsk `json:"secrets"`  // asked for at Start
	Missing  []string    `json:"missing"`  // dep IDs not installed (descriptor Requires of its modules)
	Ready    bool        `json:"ready"`    // no problems anywhere and nothing missing
	// TakesFiles: some step reads From "input". A pipeline that takes no
	// files starts with one item and no inputs (Phase 18).
	TakesFiles bool `json:"takesFiles"`
}

type StepCheck struct {
	StepID   string    `json:"stepId"`
	Info     StepInfo  `json:"info"`     // Produces resolved: no "same as input" left (§8.8)
	Problems []string  `json:"problems"` // block running
	Vars     []StepVar `json:"vars"`     // variables this step can use: built-ins + earlier steps'
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
	Clip     WatchState    `json:"clip"` // Active = the clipboard trigger is on and recording; Message says why not
	Schedule ScheduleState `json:"schedule"`
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

// Template groups: the gallery shows one section for each (Phase 15).
const (
	TemplateGroupPractical = "Practical"
	TemplateGroupCool      = "Just cool"
)

type PipelineTemplate struct {
	ID       string   `json:"id"`
	Group    string   `json:"group"` // TemplateGroupPractical | TemplateGroupCool
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
	WaitTime      WaitKind = "time"      // waiting for a moment (RunCell.Until); Continue now skips it (Phase 18)
)

type PipelineRun struct {
	ID         string         `json:"id"`
	PipelineID string         `json:"pipelineId"`
	Name       string         `json:"name"`  // the pipeline's name at start
	Steps      []PipelineStep `json:"steps"` // snapshot
	Status     RunStatus      `json:"status"`
	Trigger    string         `json:"trigger"` // "manual" | "watch" | "clipboard" | "pipeline" | "schedule"
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
	Wait       WaitKind   `json:"wait"`  // when waiting
	Until      int64      `json:"until"` // WaitTime: when it is prepared again (Unix ms); 0 = none (Phase 18)
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
	Inputs     []string          `json:"inputs"`  // paths or http(s) links; 1–200 (none when the pipeline takes no files)
	Secrets    map[string]string `json:"secrets"` // "<stepId>.<key>" → value
	Params     map[string]string `json:"params"`  // PipelineParam.Name → value; missing = its default (Phase 16)
}

type RunFilter struct {
	PipelineID string `json:"pipelineId"` // "" = all
	ActiveOnly bool   `json:"activeOnly"`
	Limit      int    `json:"limit"` // default 50, max 200
}

type ContinueRequest struct {
	RunID  string `json:"runId"`
	Item   int    `json:"item"`
	StepID string `json:"stepId"`
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
