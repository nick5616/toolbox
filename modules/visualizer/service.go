package visualizer

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
)

// Service is the Visualizer's typed Wails service.
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Enqueue queues one job.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal visualizer options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// Analysis returns a cached analysis by key.
func (s *Service) Analysis(key string) (viz.AnalysisRef, error) {
	if ref, ok := s.m.an.Lookup(key); ok {
		return ref, nil
	}
	return viz.AnalysisRef{}, core.Errorf(core.CodeNotFound, "That analysis is no longer available").WithHint("Analyze the file again")
}

// AnalysisFor returns the most recent cached analysis of path, if any.
func (s *Service) AnalysisFor(path string, stems bool) (viz.AnalysisRef, bool) {
	return s.m.an.AnalysisFor(path, stems)
}

// Fonts lists the fonts offered for text.
func (s *Service) Fonts() []string { return media.Fonts() }

// ChatStatus reports whether Deeper reading can run.
func (s *Service) ChatStatus() ChatStatus {
	if s.m.textgen == nil {
		return ChatStatus{}
	}
	model, err := s.m.textgen.Ready()
	return ChatStatus{Model: model, Ready: err == nil}
}

// MoodReaderReady reports whether the mood reader is installed.
func (s *Service) MoodReaderReady() bool { return s.m.modelPresent(PresetMood) }

// ResultShape exists so the binding generator emits Result; it returns the
// zero value.
func (s *Service) ResultShape() Result { return Result{} }
