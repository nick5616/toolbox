package pipelines

import (
	"toolbox/core"
	"toolbox/core/pipeline"
)

// Service is the Pipelines page's typed Wails service (SPEC.md §9.3). It is a
// thin layer over core/pipeline.Runner.
type Service struct {
	r *pipeline.Runner
}

// NewService builds the service.
func NewService(r *pipeline.Runner) *Service { return &Service{r: r} }

// List returns every pipeline with its check, watch state and last run.
func (s *Service) List() []core.PipelineEntry { return s.r.List() }

// Catalog lists the step types.
func (s *Service) Catalog() []core.StepType { return s.r.Catalog() }

// Templates lists the built-in templates.
func (s *Service) Templates() []core.PipelineTemplate { return Templates() }

// Describe checks a pipeline without saving it.
func (s *Service) Describe(p core.Pipeline) core.PipelineCheck { return s.r.Describe(p) }

// Save creates (ID "") or updates a pipeline.
func (s *Service) Save(p core.Pipeline) (core.PipelineEntry, error) { return s.r.Save(p) }

// Delete removes a pipeline; its runs keep going.
func (s *Service) Delete(id string) error { return s.r.Delete(id) }

// Duplicate saves a copy named "<name> copy".
func (s *Service) Duplicate(id string) (core.PipelineEntry, error) { return s.r.Duplicate(id) }

// FromTemplate returns an unsaved copy of a template with fresh step IDs and
// a free name.
func (s *Service) FromTemplate(templateID string) (core.Pipeline, error) {
	return FromTemplate(templateID, s.r.List())
}

// Start starts a run.
func (s *Service) Start(req core.RunRequest) (core.PipelineRun, error) {
	return s.r.StartRun(req, "manual")
}

// Runs lists runs, newest first.
func (s *Service) Runs(f core.RunFilter) ([]core.PipelineRun, error) { return s.r.Runs(f) }

// Run returns one run.
func (s *Service) Run(id string) (core.PipelineRun, error) { return s.r.Run(id) }

// Cancel cancels a run.
func (s *Service) Cancel(runID string) error { return s.r.Cancel(runID) }

// Retry retries a run's failed and cancelled cells.
func (s *Service) Retry(runID string) (core.PipelineRun, error) { return s.r.Retry(runID) }

// Continue carries a waiting manual or check cell on.
func (s *Service) Continue(req core.ContinueRequest) error { return s.r.Continue(req) }

// SkipStep carries a waiting cell's inputs on unchanged.
func (s *Service) SkipStep(runID string, item int, stepID string) error {
	return s.r.SkipStep(runID, item, stepID)
}

// StopItem stops one item of a run.
func (s *Service) StopItem(runID string, item int) error { return s.r.StopItem(runID, item) }

// CleanUp deletes a finished run's temporary files now.
func (s *Service) CleanUp(runID string) (int, error) { return s.r.CleanUp(runID) }

// Remove deletes a finished run.
func (s *Service) Remove(runID string, deleteTemporary bool) error {
	return s.r.Remove(runID, deleteTemporary)
}

// RenameShape and the other *Shape methods only put the built-in step
// options into the generated bindings.
func (s *Service) RenameShape() RenameStep { return DefaultRename() }
func (s *Service) ChatShape() ChatStep     { return DefaultChat() }
func (s *Service) TableShape() TableStep   { return DefaultTable() }
func (s *Service) ZipShape() ZipStep       { return DefaultZip() }
func (s *Service) CopyShape() CopyStep     { return DefaultCopy() }
func (s *Service) RunShape() RunStep       { return DefaultRun() }
func (s *Service) WaitShape() WaitStep     { return DefaultWait() }
func (s *Service) OpenShape() OpenStep     { return DefaultOpen() }
