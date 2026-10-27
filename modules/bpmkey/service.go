package bpmkey

import (
	"context"

	"toolbox/core"
)

// Service is the BPM & Key typed Wails service.
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Enqueue queues one analysis job per file.
func (s *Service) Enqueue(paths []string) ([]core.Job, error) {
	return s.jobs.Submit(context.Background(), ModuleID, paths, "{}")
}

// ResultShape exists so the binding generator emits the Result type for the
// frontend; it returns the zero value.
func (s *Service) ResultShape() Result { return Result{} }
