package subtitles

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is Subtitles' typed Wails service.
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
		return nil, fmt.Errorf("marshal subtitles options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// Load parses an .srt or .vtt file into cues.
func (s *Service) Load(path string) ([]Cue, error) { return load(path) }

// TranslationLanguages lists the translation targets, sorted by name.
func (s *Service) TranslationLanguages() []Language { return translationLanguages() }

// Styles lists the burn-in styles in UI order.
func (s *Service) Styles() []StyleInfo { return styles() }

// TranslatorStatus says whether Local Chat can translate right now.
func (s *Service) TranslatorStatus() TranslatorStatus { return s.m.translatorStatus() }

// ResultShape exists so the binding generator emits Result; it returns the
// zero value.
func (s *Service) ResultShape() Result { return Result{} }
