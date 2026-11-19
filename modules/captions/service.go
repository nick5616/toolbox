package captions

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
	"toolbox/core/deps"
)

// Service is Caption Writer's Wails service (the method set is final).
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService makes the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// Defaults returns the tool's starting options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Fields lists a preset's fields in display order.
func (s *Service) Fields(p Preset) []Field { return PresetFields(p) }

// Enqueue submits a captions job (any Action).
func (s *Service) Enqueue(inputs []string, opts Options) ([]core.Job, error) {
	if inputs == nil {
		inputs = []string{}
	}
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal caption options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, inputs, string(raw))
}

// Status says which model will read pictures and what else is available.
func (s *Service) Status() Status {
	st := Status{}
	if model, err := s.m.visionModel(); err != nil {
		st.Problem = errText(err)
	} else {
		st.Model, st.ModelLabel = model, model
	}
	if s.m.cfg.Resolve != nil {
		_, e1 := s.m.cfg.Resolve(deps.ExifTool)
		_, e2 := s.m.cfg.Resolve(deps.FFmpeg)
		st.ExifTool, st.FFmpeg = e1 == nil, e2 == nil
	}
	st.SearchHints = s.m.cfg.SearchInstalled != nil && s.m.cfg.SearchInstalled()
	return st
}

// Batches lists past batches, newest first.
func (s *Service) Batches() ([]BatchInfo, error) { return s.m.batches() }

// Batch reads one batch's captions.json.
func (s *Service) Batch(dir string) (Batch, error) { return s.m.readBatch(dir) }

// SaveBatch validates and atomically writes the user's edits (and updates
// Smart search's caption text).
func (s *Service) SaveBatch(b Batch) error { return s.m.saveBatch(context.Background(), b) }

// ExportText writes the batch as one .md, or one .txt per file next to the
// batch file; returns the written paths.
func (s *Service) ExportText(dir string, format string) ([]string, error) {
	return s.m.exportText(dir, format)
}

// DeleteBatch moves a batch folder to the OS trash.
func (s *Service) DeleteBatch(dir string) error { return s.m.deleteBatch(dir) }

// StepShape keeps the step's option type in the bindings.
func (s *Service) StepShape() Options { return DefaultOptions() }
