package core

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// IndeterminateProgress marks progress whose total is unknown.
const IndeterminateProgress = -1.0

// JobHooks connect a JobContext to the job manager (or to a test recorder).
// Any nil hook is a no-op (Output and Tool then return errors).
type JobHooks struct {
	Progress func(pct float64, msg string)
	Log      func(stream LogStream, line string)
	Title    func(title string)
	Output   func(path string) (Output, error)
	Tool     func(depID string) (string, error)
}

// JobContext is what Module.Run receives.
type JobContext struct {
	ID       string
	ModuleID string
	Inputs   []string
	Options  json.RawMessage
	Attempt  int
	// OutputDir is <library>/<OutputSubdir>; it exists before Run starts.
	OutputDir string
	// TempDir is a per-job scratch dir; it exists before Run and is deleted
	// after Run returns, whatever the outcome.
	TempDir string

	hooks JobHooks
}

// NewJobContext builds a context. Used by the job manager and module tests.
func NewJobContext(base JobContext, hooks JobHooks) *JobContext {
	base.hooks = hooks
	return &base
}

// Progress reports pct in [0,1], or IndeterminateProgress, with a short
// human-readable message such as "Downloading · 4.2 MiB/s · ETA 0:31".
func (j *JobContext) Progress(pct float64, msg string) {
	if j.hooks.Progress != nil {
		j.hooks.Progress(pct, msg)
	}
}

// Log records one line of output.
func (j *JobContext) Log(stream LogStream, line string) {
	if j.hooks.Log != nil {
		j.hooks.Log(stream, line)
	}
}

// Logf records a system log line.
func (j *JobContext) Logf(format string, args ...any) {
	j.Log(StreamSystem, fmt.Sprintf(format, args...))
}

// SetTitle sets the job's display title (e.g. the media title once known).
func (j *JobContext) SetTitle(title string) {
	if j.hooks.Title != nil {
		j.hooks.Title(title)
	}
}

// Output registers a finished file in the library.
func (j *JobContext) Output(path string) (Output, error) {
	if j.hooks.Output == nil {
		return Output{}, fmt.Errorf("register output %q: no output hook", path)
	}
	return j.hooks.Output(path)
}

// Tool resolves an external dependency to an absolute path, or returns an
// *AppError with CodeDependencyMissing.
func (j *JobContext) Tool(depID string) (string, error) {
	if j.hooks.Tool == nil {
		return "", ErrDependencyMissing(depID, "")
	}
	return j.hooks.Tool(depID)
}

// DecodeOptions strictly decodes the job's options into T. Empty options
// decode as "{}". Unknown fields are rejected.
func DecodeOptions[T any](j *JobContext) (T, error) {
	return DecodeOptionsJSON[T](j.Options)
}

// DecodeOptionsJSON is DecodeOptions for raw JSON (used by Validate).
func DecodeOptionsJSON[T any](raw json.RawMessage) (T, error) {
	var v T
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		return v, ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return v, nil
}
