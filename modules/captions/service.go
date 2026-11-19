package captions

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is Caption Writer's Wails service. CONTRACT STUB (Wave 0): the
// method set is final; C2 implements the bodies marked stub.
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
// stub
func (s *Service) Status() Status { return Status{Problem: "Caption Writer isn't ready yet"} }

// Batches lists past batches, newest first. stub
func (s *Service) Batches() ([]BatchInfo, error) { return []BatchInfo{}, nil }

// Batch reads one batch's captions.json. stub
func (s *Service) Batch(dir string) (Batch, error) {
	return Batch{}, core.Errorf(core.CodeNotImplemented, "Caption Writer isn't ready yet")
}

// SaveBatch validates and atomically writes the user's edits (and updates
// Smart search's caption text). stub
func (s *Service) SaveBatch(b Batch) error {
	return core.Errorf(core.CodeNotImplemented, "Caption Writer isn't ready yet")
}

// ExportText writes the batch as one .md, or one .txt per file next to the
// batch file; returns the written paths. stub
func (s *Service) ExportText(dir string, format string) ([]string, error) {
	return nil, core.Errorf(core.CodeNotImplemented, "Caption Writer isn't ready yet")
}

// DeleteBatch moves a batch folder to the OS trash. stub
func (s *Service) DeleteBatch(dir string) error {
	return core.Errorf(core.CodeNotImplemented, "Caption Writer isn't ready yet")
}

// StepShape keeps the step's option type in the bindings.
func (s *Service) StepShape() Options { return DefaultOptions() }
