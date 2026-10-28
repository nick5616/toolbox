package pdf

import (
	"context"

	"toolbox/core"
)

// Service is the PDF Toolkit's typed Wails service.
type Service struct {
	jobs *core.Jobs
	mod  *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, mod *Module) *Service { return &Service{jobs: jobs, mod: mod} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Actions lists the actions in UI order.
func (s *Service) Actions() []Action { return AllActions() }

// Info reads a PDF's page count, sizes and encryption state. password may be
// "" (wrong password → validation "Wrong password").
func (s *Service) Info(path string, password string) (Info, error) {
	return s.mod.info(context.Background(), path, password)
}

// Thumbnail renders one page (1-based) as a JPEG data URL, width 80..1200 px.
func (s *Service) Thumbnail(path string, page int, width int, password string) (string, error) {
	return s.mod.thumbnail(context.Background(), path, page, width, password)
}

// Enqueue queues jobs for an action: one job for merge and images-to-pdf,
// one per input otherwise. Passwords are kept in memory only (SPEC §6.2):
// password opens encrypted inputs / is the one to remove; newPassword is the
// one protect sets.
func (s *Service) Enqueue(paths []string, opts Options, password string, newPassword string) ([]core.Job, error) {
	return s.mod.enqueue(context.Background(), s.jobs, paths, opts, password, newPassword)
}

// ResultShape exists so the binding generator emits the Result type for the
// frontend; it returns the zero value.
func (s *Service) ResultShape() Result { return Result{} }
