package documents

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is the Document Converter's typed Wails service.
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// StepShape exposes the pipeline step's options type to the bindings (the
// step's options are Options).
func (s *Service) StepShape() Options { return DefaultOptions() }

// Enqueue queues one conversion job per file.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal documents options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}
