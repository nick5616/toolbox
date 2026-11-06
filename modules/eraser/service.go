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

// SaveMask keeps a painted mask (base64 PNG, white = erase) under a name, for
// the automatic mode (the pipeline step) to erase the same area from photos
// of the same shape.
func (s *Service) SaveMask(name string, maskPNG string) (SavedMask, error) {
	return s.m.saveMask(name, maskPNG)
}

// SavedMasks lists the saved masks, newest first.
func (s *Service) SavedMasks() ([]SavedMask, error) { return s.m.listMasks() }

// DeleteMask removes a saved mask. Pipelines that use it show a problem until
// another mask is chosen.
func (s *Service) DeleteMask(id string) error { return s.m.deleteMask(id) }

// SavedMaskImage returns a saved mask as "data:image/png;base64,…".
func (s *Service) SavedMaskImage(id string) (string, error) { return s.m.maskDataURL(id) }

// StepShape exists so the binding generator emits the pipeline step's
// options; it returns the defaults.
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }

// ResultShape exists so the binding generator emits Result; it returns the
// zero value.
func (s *Service) ResultShape() Result { return Result{} }
