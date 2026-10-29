package eraser

import "toolbox/core"

// Service is Object Eraser's typed Wails service.
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// ModelStatus lists the models with their download state.
func (s *Service) ModelStatus() []ModelInfo { return s.m.modelStatus() }

// Erase writes maskPNG (base64 PNG, white = erase, the image's aspect
// ratio) to the mask folder and queues the job.
func (s *Service) Erase(input string, maskPNG string, opts Options) (core.Job, error) {
	return s.m.erase(s.jobs, input, maskPNG, opts)
}

// ResultShape exists so the binding generator emits Result; it returns the
// zero value.
func (s *Service) ResultShape() Result { return Result{} }
