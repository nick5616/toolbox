package upscale

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is the Upscaler's typed Wails service.
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Models lists the presets in UI order.
func (s *Service) Models() []ModelInfo { return ModelInfos() }

// Limits returns the pixel caps the UI checks before submitting.
func (s *Service) Limits() Limits {
	return Limits{MaxOutputPixels: MaxOutputPixels, MaxCPUInputPixels: MaxCPUInputPixels}
}

// Limits are the Upscaler's pixel caps.
type Limits struct {
	MaxOutputPixels   int `json:"maxOutputPixels"`
	MaxCPUInputPixels int `json:"maxCpuInputPixels"`
}

// Enqueue queues one job per image.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal upscaler options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits the Result type for the
// frontend; it returns the zero value.
func (s *Service) ResultShape() Result { return Result{} }
