package transcribe

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is Transcribe's typed Wails service.
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Presets lists the models (PresetInfo.ID is the Model).
func (s *Service) Presets() []core.PresetInfo { return PresetInfos() }

// Languages lists the selectable languages.
func (s *Service) Languages() []Language { return Languages() }

// Enqueue queues one transcription job per file.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal transcribe options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits the Result type for the
// frontend; it returns the zero value.
func (s *Service) ResultShape() Result { return Result{} }
