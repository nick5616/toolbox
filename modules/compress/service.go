package compress

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"toolbox/core"
	"toolbox/core/par"
)

// Service is Compress to Size's typed Wails service.
type Service struct {
	jobs *core.Jobs
	mod  *Module
}

// NewService builds the service. resolve finds ffmpeg/ffprobe for Estimate.
func NewService(jobs *core.Jobs, resolve func(depID string) (string, error)) *Service {
	return &Service{jobs: jobs, mod: &Module{resolve: resolve}}
}

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Targets lists where files can be going, with their limits, in display order.
func (s *Service) Targets() []Target { return Targets() }

// TargetsAsOf is when the target limits were last checked ("2026-11").
func (s *Service) TargetsAsOf() string { return TargetsAsOf }

// Enqueue queues one compress job per file.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal compress options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// estimateTimeout bounds the look at one file.
const estimateTimeout = 30 * time.Second

// maxEstimate caps how many files one Estimate call looks at.
const maxEstimate = 200

// estimateParallel bounds how many files Estimate looks at at once.
const estimateParallel = 6

// Estimate says what compressing each file would do, without writing
// anything (probing only). One entry per path, in order; problems with a
// file are in its Problem, never an error.
func (s *Service) Estimate(paths []string, opts Options) ([]Estimate, error) {
	if err := opts.Validate(); err != nil {
		return nil, err
	}
	if len(paths) > maxEstimate {
		paths = paths[:maxEstimate]
	}
	// Files are independent: probe-bound kinds run 6 at a time, photo
	// estimates (decode + re-encode through the quality ladder) share a
	// smaller CPU-bound slot pool. Results are collected by index.
	photoSlots := make(chan struct{}, par.CPUHalf())
	out, err := par.Map(context.Background(), len(paths), estimateParallel, func(ctx context.Context, i int) (Estimate, error) {
		if KindOf(paths[i]) == KindImage {
			photoSlots <- struct{}{}
			defer func() { <-photoSlots }()
		}
		ctx, cancel := context.WithTimeout(ctx, estimateTimeout)
		defer cancel()
		return s.mod.estimate(ctx, paths[i], opts), nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ResultShape exists so the binding generator emits Result.
func (s *Service) ResultShape() Result { return Result{} }

// StepShape returns the pipeline step options (bindings only).
func (s *Service) StepShape() Options { return DefaultOptions() }
