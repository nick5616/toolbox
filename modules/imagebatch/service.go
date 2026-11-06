package imagebatch

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"toolbox/core"
)

// previewMaxDim is the long side of a preview.
const previewMaxDim = 1000

// Service is Image Batch's typed Wails service.
type Service struct {
	jobs    *core.Jobs
	resolve func(depID string) (string, error)
	tmpDir  string
}

// NewService builds the service. resolve finds FFmpeg (text watermark
// previews); tmpDir is where previews keep their scratch files ("" = the
// system temp directory).
func NewService(jobs *core.Jobs, resolve func(depID string) (string, error), tmpDir string) *Service {
	return &Service{jobs: jobs, resolve: resolve, tmpDir: tmpDir}
}

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Enqueue queues one batch job with every picture.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal image batch options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits Result.
func (s *Service) ResultShape() Result { return Result{} }

// StepShape returns the pipeline step options (bindings only).
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }

// Fonts lists the fonts offered for text watermarks.
func (s *Service) Fonts() []string { return fonts() }

// Preview renders one picture as the batch would (at most 1000 px on the
// long side) and returns it as a data URL. Nothing is written to the library.
func (s *Service) Preview(path string, opts Options) (string, error) {
	if err := opts.Validate(); err != nil {
		return "", err
	}
	if err := core.ValidateFileInputs([]string{path}, Accepts()); err != nil {
		return "", err
	}
	if s.tmpDir != "" {
		if err := os.MkdirAll(s.tmpDir, 0o755); err != nil {
			return "", fmt.Errorf("create preview dir: %w", err)
		}
	}
	work, err := os.MkdirTemp(s.tmpDir, "imagebatch-preview-")
	if err != nil {
		return "", fmt.Errorf("create preview dir: %w", err)
	}
	defer os.RemoveAll(work)
	e := &engine{
		ffmpeg: func() (string, error) {
			if s.resolve == nil {
				return "", core.ErrDependencyMissing("ffmpeg", "Install FFmpeg from Settings")
			}
			return s.resolve("ffmpeg")
		},
		now: time.Now,
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	return e.preview(ctx, path, opts, work, previewMaxDim)
}
