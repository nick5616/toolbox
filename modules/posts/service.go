package posts

import (
	"context"

	"toolbox/core"
)

// Service is the Post Builder's typed Wails service (SPEC.md §B7.4).
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// List returns the posts, most recently updated first.
func (s *Service) List() ([]core.ProjectInfo, error) { return s.m.docs.List(context.Background()) }

// Get returns a post.
func (s *Service) Get(id string) (Post, error) {
	return projectdocsGet(s.m, id)
}

// Create makes a post; paths become photo/clip slides.
func (s *Service) Create(name, format, aspect string, paths []string) (core.ProjectInfo, error) {
	return core.ProjectInfo{}, core.NotImplemented("Post Builder") // WP-PB1
}

// Save validates the shape and stores a post (Check issues don't block saving).
func (s *Service) Save(id, name string, doc Post) (core.ProjectInfo, error) {
	return core.ProjectInfo{}, core.NotImplemented("Post Builder") // WP-PB1
}

// Duplicate copies a post.
func (s *Service) Duplicate(id string) (core.ProjectInfo, error) {
	return s.m.docs.Duplicate(context.Background(), id)
}

// Delete removes a post (its exports stay in the Library).
func (s *Service) Delete(id string) error { return s.m.docs.Delete(context.Background(), id) }

// Check returns the post's issues (errors block Export).
func (s *Service) Check(doc Post) []Issue { return s.m.Check(context.Background(), doc) }

// Export submits the export job.
func (s *Service) Export(id string) (core.Job, error) {
	return core.Job{}, core.NotImplemented("Post Builder") // WP-PB1
}

// SlideInfo describes files before they become slides.
func (s *Service) SlideInfo(paths []string) ([]SlideSource, error) {
	return nil, core.NotImplemented("Post Builder") // WP-PB1
}

// Limits returns the Instagram limits the checks use.
func (s *Service) Limits() Limits { return DefaultLimits() }

// ExportShape only puts the export result type into the bindings.
func (s *Service) ExportShape() ExportResult { return ExportResult{} }
