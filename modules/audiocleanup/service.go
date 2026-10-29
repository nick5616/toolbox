package audiocleanup

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is Audio Cleanup's typed Wails service.
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Enqueue queues one job per input (or one preview job for paths[0] when
// opts.Preview is set).
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal audio cleanup options: %w", err)
	}
	if opts.Preview && len(paths) > 1 {
		paths = paths[:1]
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// DiscardPreviews deletes all preview excerpts (the view calls it on unmount).
func (s *Service) DiscardPreviews() { s.m.prunePreviewsAll() }

// ResultShape exists so the binding generator emits Result; it returns the
// zero value.
func (s *Service) ResultShape() Result { return Result{} }
