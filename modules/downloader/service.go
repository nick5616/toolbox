package downloader

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is the downloader's typed Wails service.
type Service struct {
	jobs *core.Jobs
}

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service {
	return &Service{jobs: jobs}
}

// Defaults returns the default options.
func (s *Service) Defaults() Options {
	return DefaultOptions()
}

// Enqueue validates and queues one download job per URL.
func (s *Service) Enqueue(urls []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal downloader options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, urls, string(raw))
}
