package ocr

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is OCR's typed Wails service.
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Languages lists the language choices.
func (s *Service) Languages() []LanguageInfo { return Languages() }

// Enqueue queues one job per input.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal ocr options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits the Result type for the
// frontend; it returns the zero value.
func (s *Service) ResultShape() Result { return Result{} }
