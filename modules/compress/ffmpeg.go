package compress

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// toolFunc resolves an external tool by dep ID (job.Tool, or deps.Service.Resolve).
type toolFunc func(depID string) (string, error)

// commonArgs start every FFmpeg run: quiet, overwrite, machine progress on stdout.
func commonArgs() []string {
	return []string{"-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"}
}

// runFF runs one FFmpeg invocation with dir as its working directory (pass
// the job's TempDir so filters and pass logs never hold Windows paths),
// mapping -progress to job progress over durSec seconds of output. job may be
// nil (no progress, no logs).
func runFF(ctx context.Context, job *core.JobContext, ffmpeg, dir string, args []string, durSec float64, label string) error {
	tracker := &media.ProgressTracker{Duration: durSec, Label: label}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	res, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg,
		Args: args,
		Dir:  dir,
		OnStdout: func(l string) {
			if job == nil {
				return
			}
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				job.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			if job != nil {
				job.Log(core.StreamStderr, l)
			}
			mu.Lock()
			lastStderr = l
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("compress cancelled: %w", ctxErr)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return fmt.Errorf("run ffmpeg: %w", err)
		}
		mu.Lock()
		msg := strings.TrimSpace(lastStderr)
		mu.Unlock()
		if msg == "" {
			msg = fmt.Sprintf("ffmpeg exited with code %d", res.ExitCode)
		}
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	return nil
}
