package core

// Wire types shared by the core and the frontend (via generated bindings).
// Times are Unix milliseconds; 0 means unset.

// JobStatus is the lifecycle state of a job.
type JobStatus string

const (
	JobQueued    JobStatus = "queued"
	JobRunning   JobStatus = "running"
	JobDone      JobStatus = "done"
	JobFailed    JobStatus = "failed"
	JobCancelled JobStatus = "cancelled"
)

// Finished reports whether s is terminal.
func (s JobStatus) Finished() bool {
	return s == JobDone || s == JobFailed || s == JobCancelled
}

// Job is the persisted record of one unit of work.
type Job struct {
	ID       string    `json:"id"`
	ModuleID string    `json:"moduleId"`
	Title    string    `json:"title"`
	Status   JobStatus `json:"status"`
	// Progress is 0..1, or -1 when indeterminate.
	Progress        float64   `json:"progress"`
	Message         string    `json:"message"`
	Inputs          []string  `json:"inputs"`
	OptionsJSON     string    `json:"optionsJson"`
	ErrorCode       ErrorCode `json:"errorCode"`
	Error           string    `json:"error"`
	ErrorHint       string    `json:"errorHint"`
	Attempt         int       `json:"attempt"`
	CancelRequested bool      `json:"cancelRequested"`
	CreatedAt       int64     `json:"createdAt"`
	StartedAt       int64     `json:"startedAt"`
	FinishedAt      int64     `json:"finishedAt"`
	Outputs         []Output  `json:"outputs"`
	// ResultJSON is module-specific result data (e.g. BPM & key); "" if none.
	ResultJSON string `json:"resultJson"`
}

// JobFilter selects jobs, newest first.
type JobFilter struct {
	ModuleID string      `json:"moduleId"`
	Statuses []JobStatus `json:"statuses"`
	Limit    int         `json:"limit"` // default 100, max 500
}

// JobProgress is the payload of jobs:progress.
type JobProgress struct {
	ID       string  `json:"id"`
	Progress float64 `json:"progress"`
	Message  string  `json:"message"`
}

// LogStream identifies where a log line came from.
type LogStream string

const (
	StreamStdout LogStream = "stdout"
	StreamStderr LogStream = "stderr"
	StreamSystem LogStream = "system"
)

// LogLine is one line of job output.
type LogLine struct {
	Seq    int       `json:"seq"`
	TS     int64     `json:"ts"`
	Stream LogStream `json:"stream"`
	Text   string    `json:"text"`
}

// JobLogBatch is the payload of jobs:log.
type JobLogBatch struct {
	ID    string    `json:"id"`
	Lines []LogLine `json:"lines"`
}

// JobsRemoved is the payload of jobs:removed.
type JobsRemoved struct {
	IDs []string `json:"ids"`
}

// OutputKind is a coarse file type.
type OutputKind string

const (
	KindAudio    OutputKind = "audio"
	KindVideo    OutputKind = "video"
	KindImage    OutputKind = "image"
	KindDocument OutputKind = "document"
	KindOther    OutputKind = "other"
)

// Output is a file registered in the library.
type Output struct {
	ID        string     `json:"id"`
	JobID     string     `json:"jobId"` // "" when the job was removed
	ModuleID  string     `json:"moduleId"`
	Path      string     `json:"path"`
	Name      string     `json:"name"`
	Kind      OutputKind `json:"kind"`
	SizeBytes int64      `json:"sizeBytes"`
	CreatedAt int64      `json:"createdAt"`
	Tags      []string   `json:"tags"`
	// Missing is computed on read: the file no longer exists.
	Missing bool `json:"missing"`
}

// OutputQuery pages through outputs, newest first.
type OutputQuery struct {
	ModuleID string `json:"moduleId"`
	Search   string `json:"search"`
	Limit    int    `json:"limit"`  // default 100, max 500
	Cursor   string `json:"cursor"` // opaque; "" = first page
}

// OutputPage is one page of outputs.
type OutputPage struct {
	Items      []Output `json:"items"`
	NextCursor string   `json:"nextCursor"` // "" = end
}

// OutputsRemoved is the payload of library:removed.
type OutputsRemoved struct {
	IDs []string `json:"ids"`
}

// Theme is the UI colour scheme preference.
type Theme string

const (
	ThemeSystem Theme = "system"
	ThemeDark   Theme = "dark"
	ThemeLight  Theme = "light"
)

// Settings are user preferences.
type Settings struct {
	LibraryDir  string `json:"libraryDir"`
	Concurrency int    `json:"concurrency"`
	Theme       Theme  `json:"theme"`
}

// SettingsPatch updates only the non-nil fields.
type SettingsPatch struct {
	LibraryDir  *string `json:"libraryDir"`
	Concurrency *int    `json:"concurrency"`
	Theme       *Theme  `json:"theme"`
}

// DepState is the detection result for an external tool.
type DepState string

const (
	DepOK       DepState = "ok"
	DepMissing  DepState = "missing"
	DepError    DepState = "error"
	DepOutdated DepState = "outdated" // installed, but older than this build expects
)

// DepSource says where a tool was found.
type DepSource string

const (
	SourceNone     DepSource = ""
	SourceManaged  DepSource = "managed"
	SourcePath     DepSource = "path"
	SourceKnownDir DepSource = "known-dir"
)

// DepStatus describes one external tool.
type DepStatus struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Purpose       string    `json:"purpose"`
	State         DepState  `json:"state"`
	Version       string    `json:"version"`
	Path          string    `json:"path"`
	Source        DepSource `json:"source"`
	Managed       bool      `json:"managed"`
	Required      bool      `json:"required"`
	RequiredBy    []string  `json:"requiredBy"`
	RecommendedBy []string  `json:"recommendedBy"`
	InstallHint   string    `json:"installHint"`
	Error         string    `json:"error"`
	CheckedAt     int64     `json:"checkedAt"`
}

// DepsChanged is the payload of deps:changed.
type DepsChanged struct {
	Deps []DepStatus `json:"deps"`
}

// ModuleMatch is a module that accepts some of the given paths.
type ModuleMatch struct {
	Module Descriptor `json:"module"`
	Paths  []string   `json:"paths"`
}

// MatchResult answers "which modules accept these files?".
type MatchResult struct {
	Matches   []ModuleMatch `json:"matches"`   // ready first, then by Order
	Unmatched []string      `json:"unmatched"` // includes directories
}

// FilesDropped is the payload of app:files-dropped.
type FilesDropped struct {
	Paths  []string    `json:"paths"`
	Result MatchResult `json:"result"`
	// TargetID is the id of the drop-target element ("tool-drop:<moduleId>"
	// routes straight to that tool).
	TargetID string `json:"targetId"`
}

// FileInfo describes a local file for input lists.
type FileInfo struct {
	Path      string     `json:"path"`
	Name      string     `json:"name"`
	SizeBytes int64      `json:"sizeBytes"`
	Exists    bool       `json:"exists"`
	IsDir     bool       `json:"isDir"`
	Kind      OutputKind `json:"kind"`
}

// Navigate is the payload of app:navigate.
type Navigate struct {
	Target string `json:"target"` // "settings" | "library" | module ID
}

// AppInfo describes the running app and its directories.
type AppInfo struct {
	Version    string `json:"version"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	SupportDir string `json:"supportDir"`
	DBPath     string `json:"dbPath"`
	LogPath    string `json:"logPath"`
	LibraryDir string `json:"libraryDir"`
}

// PresetInfo describes a module preset for the UI. Fields that don't apply to
// a module are zero.
type PresetInfo struct {
	ID            string       `json:"id"`
	Label         string       `json:"label"`
	Group         string       `json:"group"` // UI grouping, e.g. "Audio", "Video", "Image"
	Kind          OutputKind   `json:"kind"`
	Ext           string       `json:"ext"`
	AcceptsKinds  []OutputKind `json:"acceptsKinds"`
	DownloadBytes int64        `json:"downloadBytes"`
	Stems         []string     `json:"stems"`
	Speed         string       `json:"speed"` // "fast" | "best"
}
