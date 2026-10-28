package exif

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is the EXIF tool's typed Wails service.
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// EditableFields lists the editable field names in UI order.
func (s *Service) EditableFields() []string { return EditableFields() }

// Read returns a file's metadata for the inspector.
func (s *Service) Read(path string) (MetadataView, error) {
	return s.m.Read(context.Background(), path)
}

// Enqueue queues one job per file. Outputs are always new files.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal exif options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits the Result type for the
// frontend; it returns the zero value.
func (s *Service) ResultShape() Result { return Result{} }
