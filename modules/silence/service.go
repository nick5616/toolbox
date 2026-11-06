package silence

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"toolbox/core"
	"toolbox/core/media"
)

// Service is the Silence Cutter's typed Wails service.
type Service struct {
	jobs    *core.Jobs
	resolve func(depID string) (string, error)
}

// NewService builds the service. resolve finds ffmpeg/ffprobe for Analyse.
func NewService(jobs *core.Jobs, resolve func(depID string) (string, error)) *Service {
	return &Service{jobs: jobs, resolve: resolve}
}

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Enqueue queues one cut job per file.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal silence options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits Result.
func (s *Service) ResultShape() Result { return Result{} }

// StepShape returns the pipeline step options (bindings only).
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }

// analyseTimeout bounds a quick look.
const analyseTimeout = 5 * time.Minute

// Analyse listens to a file once and says what a cut with these options
// would remove. It reads the file only; nothing is written.
func (s *Service) Analyse(path string, opts Options) (Analysis, error) {
	if err := opts.Validate(); err != nil {
		return Analysis{}, err
	}
	if err := core.ValidateFileInputs([]string{path}, Accepts()); err != nil {
		return Analysis{}, err
	}
	if s.resolve == nil {
		return Analysis{}, core.ErrDependencyMissing("ffmpeg", "Install FFmpeg from Settings")
	}
	ffmpeg, err := s.resolve("ffmpeg")
	if err != nil {
		return Analysis{}, err
	}
	ffprobe, err := s.resolve("ffprobe")
	if err != nil {
		return Analysis{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), analyseTimeout)
	defer cancel()
	info, err := media.Probe(ctx, ffprobe, path)
	if err != nil {
		return Analysis{}, err
	}
	if len(info.Audio) == 0 {
		return Analysis{}, core.ValidationError("This file has no sound to measure", nil)
	}
	silences, err := detect(ctx, nil, ffmpeg, path, opts, info.DurationMs)
	if err != nil {
		return Analysis{}, err
	}
	return analysisOf(silences, info.DurationMs, opts.PaddingMs), nil
}

func analysisOf(silences []Range, durationMs int64, paddingMs int) Analysis {
	removed, kept := Plan(silences, durationMs, paddingMs)
	if silences == nil {
		silences = []Range{}
	}
	return Analysis{DurationMs: durationMs, Silences: silences, Removed: removed, Kept: kept, RemovedMs: total(removed), KeptMs: total(kept)}
}
