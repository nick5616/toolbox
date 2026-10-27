package stems

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is the Stem Splitter's typed Wails service.
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Presets lists the separation presets.
func (s *Service) Presets() []core.PresetInfo { return PresetInfos() }

// Enqueue queues one separation job per file.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal stems options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}
