package trimmer

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is the Video Trimmer's typed Wails service.
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Enqueue queues one trim job.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal trimmer options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits Result; it returns the
// zero value.
func (s *Service) ResultShape() Result { return Result{} }
