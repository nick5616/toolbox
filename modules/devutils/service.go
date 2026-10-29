package devutils

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is Dev Utilities' typed Wails service. Files are picked with
// FilesService.Pick("dev-utils") (no filter).
type Service struct{ jobs *core.Jobs }

// NewService builds the service.
func NewService(jobs *core.Jobs) *Service { return &Service{jobs: jobs} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Enqueue queues one hash job for all paths.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal dev utilities options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// HashText hashes UTF-8 text with every algorithm.
func (s *Service) HashText(text string) []HashResult { return hashText(text) }

// FileBase64 returns a file's contents as standard Base64 (≤ 10 MiB).
func (s *Service) FileBase64(path string) (string, error) { return fileBase64(path) }

// ResultShape exists so the binding generator emits Result; it returns the
// zero value.
func (s *Service) ResultShape() Result { return Result{} }
