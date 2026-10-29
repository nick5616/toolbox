package converter

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("No file to convert", nil)
	}
	preset, ok := lookup(opts.Preset)
	if !ok {
		return core.ValidationError("Unknown preset", map[string]string{"preset": "Choose a format"})
	}
	input := job.Inputs[0]
	if kind := core.KindForPath(input); !kindAccepted(preset, kind) {
		return core.ValidationError(fmt.Sprintf("%s can't take a %s file", preset.Label, kind), nil)
	}

	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}

	job.SetTitle(filepath.Base(input))

	tracker := &media.ProgressTracker{}
	if preset.Kind != core.KindImage {
		out, perr := proc.Output(ctx, 15*time.Second, ffprobe,
			"-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input)
		if ctx.Err() != nil {
			return fmt.Errorf("conversion cancelled: %w", ctx.Err())
		}
		if perr == nil {
			tracker.Duration = parseDuration(out)
		} else {
			job.Logf("Couldn't read duration: %v", perr)
		}
	}

	tmpOut := filepath.Join(job.TempDir, "out"+preset.Ext)
	args := buildArgs(opts, input, tmpOut)

	var (
		mu         sync.Mutex
		lastStderr string
		errLine    string
	)
	job.Progress(core.IndeterminateProgress, "Converting…")
	res, runErr := proc.Run(ctx, proc.Spec{
		Path: ffmpeg,
		Args: args,
		OnStdout: func(l string) {
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				job.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			job.Log(core.StreamStderr, l)
			mu.Lock()
			lastStderr = l
			if isErrorLine(l) {
				errLine = l
			}
			mu.Unlock()
		},
	})

	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("conversion cancelled: %w", ctxErr)
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return fmt.Errorf("run ffmpeg: %w", runErr)
		}
		mu.Lock()
		msg := errLine
		if msg == "" {
			msg = lastStderr
		}
		mu.Unlock()
		if msg == "" {
			msg = fmt.Sprintf("ffmpeg exited with code %d", res.ExitCode)
		}
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithHint(hintFor(msg)).WithCause(runErr)
	}

	final := core.UniquePath(job.OutputDir, core.StemName(input), preset.Ext)
	if err := moveFile(tmpOut, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the converted file").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	job.Progress(1, "Saved "+filepath.Base(final))
	return nil
}

func isErrorLine(l string) bool {
	return strings.Contains(l, "Error") || strings.Contains(l, "Invalid") || strings.Contains(l, "not")
}

func hintFor(msg string) string {
	if strings.Contains(msg, "Unknown encoder") &&
		(strings.Contains(msg, "libx265") || strings.Contains(msg, "libvpx-vp9")) {
		return "Your ffmpeg build lacks this encoder; install a full build (brew install ffmpeg)"
	}
	return ""
}

// moveFile renames src to dst, falling back to copy+remove across volumes.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return fmt.Errorf("copy to %s: %w", dst, err)
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return fmt.Errorf("close %s: %w", dst, err)
	}
	_ = in.Close()
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("remove %s: %w", src, err)
	}
	return nil
}
