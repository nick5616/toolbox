package videoeditor

import (
	"context"

	"toolbox/core"
)

// Service is the Video Editor's typed Wails service (SPEC.md §B6.4).
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// List returns the video projects, most recently updated first.
func (s *Service) List() ([]core.ProjectInfo, error) { return s.m.docs.List(context.Background()) }

// Get returns a video project.
func (s *Service) Get(id string) (VideoProject, error) { return s.m.Get(context.Background(), id) }

// Create makes an empty project at aspect.
func (s *Service) Create(name, aspect string) (core.ProjectInfo, error) {
	return core.ProjectInfo{}, core.NotImplemented("Video Editor") // WP-VE1
}

// Save validates and stores a project.
func (s *Service) Save(id, name string, doc VideoProject) (core.ProjectInfo, error) {
	return core.ProjectInfo{}, core.NotImplemented("Video Editor") // WP-VE1
}

// Duplicate copies a project.
func (s *Service) Duplicate(id string) (core.ProjectInfo, error) {
	return s.m.docs.Duplicate(context.Background(), id)
}

// Delete removes a project and its preview.
func (s *Service) Delete(id string) error { return s.m.docs.Delete(context.Background(), id) }

// Probe describes source files for the timeline.
func (s *Service) Probe(paths []string) ([]ClipInfo, error) {
	return nil, core.NotImplemented("Video Editor") // WP-VE1
}

// Plan submits a Quick vlog job; its result is {projectId}.
func (s *Service) Plan(req PlanRequest) (core.Job, error) {
	return core.Job{}, core.NotImplemented("Video Editor") // WP-VE1
}

// Render submits the project's export job.
func (s *Service) Render(id string) (core.Job, error) {
	return core.Job{}, core.NotImplemented("Video Editor") // WP-VE1
}

// Preview submits a 540p preview job.
func (s *Service) Preview(id string) (core.Job, error) {
	return core.Job{}, core.NotImplemented("Video Editor") // WP-VE1
}

// PreviewPath is the project's latest preview file ("" if none).
func (s *Service) PreviewPath(id string) string { return "" } // WP-VE1

// PlanShape and ResultShape only put types into the bindings.
func (s *Service) PlanShape() PlanResult { return PlanResult{} }
