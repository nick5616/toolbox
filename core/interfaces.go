package core

import "context"

// Storage contracts. core/store implements all three on one SQLite DB;
// tests use in-memory fakes.

// JobStore persists jobs and their logs.
type JobStore interface {
	InsertJob(ctx context.Context, j Job) error
	// UpdateJob writes all mutable columns of j.
	UpdateJob(ctx context.Context, j Job) error
	// GetJob returns an *AppError with CodeNotFound for unknown IDs.
	GetJob(ctx context.Context, id string) (Job, error)
	// ListJobs returns jobs newest first with Outputs populated.
	ListJobs(ctx context.Context, f JobFilter) ([]Job, error)
	DeleteJobs(ctx context.Context, ids []string) error
	AppendLogs(ctx context.Context, jobID string, lines []LogLine) error
	Logs(ctx context.Context, jobID string) ([]LogLine, error)
	CountLogs(ctx context.Context, jobID string) (int, error)
}

// OutputStore persists library outputs.
type OutputStore interface {
	// UpsertOutput inserts o, or updates job/module/size/created_at of the
	// existing row with the same path while keeping its ID.
	UpsertOutput(ctx context.Context, o Output) (Output, error)
	GetOutput(ctx context.Context, id string) (Output, error)
	// ListOutputs computes Missing via os.Stat.
	ListOutputs(ctx context.Context, q OutputQuery) (OutputPage, error)
	DeleteOutput(ctx context.Context, id string) error
	// MoveOutput points an output at newPath (after the file was renamed),
	// updating its name and keeping its ID and tags.
	MoveOutput(ctx context.Context, id, newPath string) (Output, error)
}

// PipelineStore persists pipelines, their runs and watch-folder state
// (SPEC.md §9.1).
type PipelineStore interface {
	ListPipelines(ctx context.Context) ([]Pipeline, error)
	// PutPipeline inserts or replaces p.
	PutPipeline(ctx context.Context, p Pipeline) error
	// DeletePipeline also deletes its watch_seen rows.
	DeletePipeline(ctx context.Context, id string) error
	// PutRun inserts or replaces a run; stateJSON is its full JSON state.
	PutRun(ctx context.Context, run PipelineRun, stateJSON string) error
	// GetRun returns an *AppError with CodeNotFound for unknown IDs.
	GetRun(ctx context.Context, id string) (stateJSON string, err error)
	// ListRuns returns state JSONs, newest first.
	ListRuns(ctx context.Context, f RunFilter) ([]string, error)
	DeleteRuns(ctx context.Context, ids []string) error
	// PruneRuns deletes finished runs beyond the newest keepFinished and
	// returns their IDs.
	PruneRuns(ctx context.Context, keepFinished int) ([]string, error)
	SeenFiles(ctx context.Context, pipelineID string) (map[string]SeenFile, error)
	MarkSeen(ctx context.Context, pipelineID string, files []SeenFile) error
	ForgetSeen(ctx context.Context, pipelineID string, paths []string) error
}

// SeenFile is a watch-folder file already handled (or baselined).
type SeenFile struct {
	Path  string
	Size  int64
	MTime int64 // Unix ms
}

// ClipStore persists clipboard history (SPEC.md §3.3). Listing returns pinned
// items first, then most recently used.
type ClipStore interface {
	// UpsertClip inserts c, or — when an item with the same Hash exists —
	// bumps its last_used_at to c.LastUsedAt and returns the stored row with
	// inserted=false.
	UpsertClip(ctx context.Context, c ClipItem) (item ClipItem, inserted bool, err error)
	ListClips(ctx context.Context, q ClipQuery) (ClipPage, error)
	// GetClip returns an *AppError with CodeNotFound for unknown IDs.
	GetClip(ctx context.Context, id string) (ClipItem, error)
	// TouchClip sets last_used_at (re-copy).
	TouchClip(ctx context.Context, id string, at int64) (ClipItem, error)
	SetPinned(ctx context.Context, id string, pinned bool) (ClipItem, error)
	// DeleteClips returns the deleted rows (callers remove image files).
	DeleteClips(ctx context.Context, ids []string) ([]ClipItem, error)
	ClearClips(ctx context.Context, keepPinned bool) ([]ClipItem, error)
	// PruneClips deletes unpinned items last used before olderThanMs (0 =
	// no age limit) and then the oldest unpinned items beyond maxItems total
	// (0 = no count limit). Returns the deleted rows.
	PruneClips(ctx context.Context, olderThanMs int64, maxItems int) ([]ClipItem, error)
}

// SettingsStore is a key/value store of JSON values.
type SettingsStore interface {
	GetSetting(ctx context.Context, key string) (value string, ok bool, err error)
	SetSetting(ctx context.Context, key, value string) error
}
