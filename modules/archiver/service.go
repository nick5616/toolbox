package archiver

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is the archiver's typed Wails service.
type Service struct {
	jobs *core.Jobs
	mod  *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service {
	return &Service{jobs: jobs, mod: New()}
}

// Defaults returns the default options.
func (s *Service) Defaults() Options {
	return DefaultOptions()
}

// Browser reports whether an installed Edge/Chrome was found, so the UI can
// disable Render JavaScript and Also PDF.
func (s *Service) Browser() BrowserInfo {
	path, name := s.mod.browser()
	return BrowserInfo{Found: path != "", Name: name}
}

// Enqueue validates and queues one archive job for the URLs.
func (s *Service) Enqueue(urls []string, opts Options) ([]core.Job, error) {
	opts.URLs = []string{}
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal archiver options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, urls, string(raw))
}
