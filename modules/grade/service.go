package grade

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is Color Grader's typed Wails service (SPEC §E4). Signatures are
// frozen since Wave 0; the bodies call the module.
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Enqueue queues one job per file.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal grade options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// Looks returns the saved looks (Mine), newest first.
func (s *Service) Looks() ([]Recipe, error) { return s.m.Looks() }

// SaveLook stores a look (≤ 200); an existing name is replaced.
func (s *Service) SaveLook(r Recipe) (Recipe, error) { return s.m.SaveLook(r) }

// RenameLook renames a saved look.
func (s *Service) RenameLook(oldName, newName string) error { return s.m.RenameLook(oldName, newName) }

// DeleteLook removes a saved look.
func (s *Service) DeleteLook(name string) error { return s.m.DeleteLook(name) }

// Vibe asks the local chat model for N looks from a description.
func (s *Service) Vibe(req VibeRequest) ([]Recipe, error) { return s.m.Vibe(req) }

// CancelVibe stops a running Vibe or Read request.
func (s *Service) CancelVibe() { s.m.CancelVibe() }

// Read asks the local vision model for 6 looks that fit the picture (atMs:
// the frame of a video).
func (s *Service) Read(path string, atMs int64) ([]Suggestion, error) { return s.m.Read(path, atMs) }

// Transfer returns the transfer op's "stats" param for a reference picture:
// 18 numbers, Lab mean (L, a, b) then standard deviation (L, a, b) for the
// shadows, mids and highlights bands in that order.
func (s *Service) Transfer(refPath string) ([]float64, error) {
	return s.m.Transfer(context.Background(), refPath)
}

// SaveCube writes a size³ LUT (RGB floats 0..1, red fastest) to
// <library>/Graded/LUTs/<name>.cube and returns its path. The file is
// registered in the Library.
func (s *Service) SaveCube(name string, size int, data []float64) (string, error) {
	return s.m.SaveCube(context.Background(), name, size, data)
}

// Maps says which region maps exist for a file.
func (s *Service) Maps(path string) (MapState, error) { return s.m.Maps(path) }

// PrepareMaps queues the region maps a file needs ("depth", "subject", "people").
func (s *Service) PrepareMaps(path string, kinds []string) (core.Job, error) {
	if _, err := mapKinds(kinds); err != nil {
		return core.Job{}, err
	}
	opts := DefaultOptions()
	opts.Action, opts.MapKinds = ActionMaps, kinds
	raw, err := json.Marshal(opts)
	if err != nil {
		return core.Job{}, fmt.Errorf("marshal grade options: %w", err)
	}
	jobs, err := s.jobs.Submit(context.Background(), ModuleID, []string{path}, string(raw))
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "The maps job wasn't queued")
	}
	return jobs[0], nil
}

// StepShape returns the pipeline step options (bindings only).
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }

// RecipeShape exists so the binding generator emits Recipe.
func (s *Service) RecipeShape() Recipe { return Recipe{} }
