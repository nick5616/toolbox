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
}

// SettingsStore is a key/value store of JSON values.
type SettingsStore interface {
	GetSetting(ctx context.Context, key string) (value string, ok bool, err error)
	SetSetting(ctx context.Context, key, value string) error
}
