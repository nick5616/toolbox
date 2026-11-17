package gif

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
	"sync/atomic"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/par"
	"toolbox/core/proc"
)

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := checkOptions(opts); err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Choose one video", nil)
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	input := job.Inputs[0]
	info, err := media.Probe(ctx, ffprobe, input)
	if err != nil {
		return err
	}
	if info.Video == nil {
		return core.ValidationError("This file has no video", nil)
	}
	if info.DurationMs <= 0 {
		return core.ValidationError("Couldn't read how long this video is", nil)
	}
	job.SetTitle(filepath.Base(input))

	var (
		tmp, ext string
		res      Result
	)
	if opts.Mode == ModeSheet {
		tmp, ext, res, err = m.runSheet(ctx, job, ffmpeg, input, info, opts)
	} else {
		tmp, ext, res, err = m.runLoop(ctx, job, ffmpeg, input, info, opts)
	}
	if err != nil {
		return err
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("render cancelled: %w", ctxErr)
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() == 0 {
		return core.Errorf(core.CodeToolFailed, "FFmpeg didn't write a picture").WithCause(err)
	}
	if opts.Mode != ModeSheet && st.Size() > MaxOutputBytes {
		return core.Errorf(core.CodeValidation, "The %s came out at %.0f MB, over the %d MB limit", strings.ToUpper(string(opts.Mode)), float64(st.Size())/(1<<20), MaxOutputBytes>>20).
			WithHint("Lower the width, the frames per second or the length")
	}
	stem := core.StemName(input)
	if opts.Mode == ModeSheet {
		stem += " (sheet)"
	}
	final := core.UniquePath(job.OutputDir, stem, ext)
	if err := moveFile(tmp, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the file").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	res.Mode, res.Outputs, res.SizeBytes = opts.Mode, []string{final}, st.Size()
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, "Saved "+filepath.Base(final))
	return nil
}

// runLoop writes a GIF (two passes) or an animated WebP into TempDir.
func (m *Module) runLoop(ctx context.Context, job *core.JobContext, ffmpeg, input string, info media.Info, o Options) (string, string, Result, error) {
	var res Result
	remaining := float64(info.DurationMs)/1000 - o.StartSec
	if remaining < MinLengthSec {
		return "", "", res, fieldErr("The start is too close to the end of the video", "startSec")
	}
	length := min(o.LengthSec, remaining)
	res.DurationMs = int64(length * 1000)
	w := min(o.Width, info.Video.Width)
	res.Width, res.Height = w&^1, (w*info.Video.Height/max(info.Video.Width, 1))&^1
	if o.Mode == ModeWebP {
		out := filepath.Join(job.TempDir, "loop.webp")
		if err := runFF(ctx, job, ffmpeg, webpArgs(input, out, o.StartSec, length, o.FPS, o.Width, o.Loop), "", length, "Making the WebP"); err != nil {
			return "", "", res, err
		}
		return out, ".webp", res, nil
	}
	palette := filepath.Join(job.TempDir, "palette.png")
	if err := runFF(ctx, job.Scoped(0, 0.3), ffmpeg, paletteArgs(input, palette, o.StartSec, length, o.FPS, o.Width), "", length, "Choosing colours"); err != nil {
		return "", "", res, err
	}
	out := filepath.Join(job.TempDir, "loop.gif")
	if err := runFF(ctx, job.Scoped(0.3, 1), ffmpeg, gifArgs(input, palette, out, o.StartSec, length, o.FPS, o.Width, o.Loop), "", length, "Making the GIF"); err != nil {
		return "", "", res, err
	}
	return out, ".gif", res, nil
}

// sheetParallel bounds concurrent single-frame runs.
const sheetParallel = 4

// runSheet writes a contact sheet JPG into TempDir: one frame per tile
// (with its timecode burned in by libass), then one tile pass.
func (m *Module) runSheet(ctx context.Context, job *core.JobContext, ffmpeg, input string, info media.Info, o Options) (string, string, Result, error) {
	var res Result
	n := o.Columns * o.Rows
	cw, ch := cellSize(o.CellWidth, info.Video.Width, info.Video.Height)
	res.Frames = n
	res.Width = o.Columns*cw + (o.Columns+1)*6
	res.Height = o.Rows*ch + (o.Rows+1)*6
	times := tileTimes(info.DurationMs, n)
	if err := ctx.Err(); err != nil {
		return "", "", res, fmt.Errorf("render cancelled: %w", err)
	}
	// Frames are independent single-frame runs with distinct file names:
	// 4 at a time; progress is a monotonic count of finished frames.
	var done atomic.Int64
	err := par.ForEach(ctx, len(times), sheetParallel, func(ctx context.Context, i int) error {
		t := times[i]
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("render cancelled: %w", err)
		}
		label := ""
		if o.Labels {
			label = fmt.Sprintf("t%03d.ass", i+1)
			f, err := os.Create(filepath.Join(job.TempDir, label))
			if err != nil {
				return fmt.Errorf("create %s: %w", label, err)
			}
			_, werr := labelDoc(timecode(t), cw, ch).WriteTo(f)
			if cerr := f.Close(); werr == nil {
				werr = cerr
			}
			if werr != nil {
				return fmt.Errorf("write %s: %w", label, werr)
			}
		}
		frame := fmt.Sprintf("t%03d.png", i+1)
		if err := runFF(ctx, job, ffmpeg, frameArgs(input, frame, float64(t)/1000, cw, ch, label), job.TempDir, 0, "Reading frames"); err != nil {
			return err
		}
		if _, err := os.Stat(filepath.Join(job.TempDir, frame)); err != nil {
			return core.Errorf(core.CodeToolFailed, "Couldn't read the frame at %s", timecode(t)).WithCause(err)
		}
		k := done.Add(1)
		job.Progress(0.9*float64(k)/float64(n), fmt.Sprintf("Frame %d of %d", k, n))
		return nil
	})
	if err != nil {
		return "", "", res, err
	}
	job.Progress(0.92, "Laying out the sheet…")
	out := "sheet.jpg"
	if err := runFF(ctx, job.Scoped(0.92, 1), ffmpeg, sheetArgs("t%03d.png", out, o.Columns, o.Rows), job.TempDir, 0, "Laying out the sheet"); err != nil {
		return "", "", res, err
	}
	return filepath.Join(job.TempDir, out), ".jpg", res, nil
}

// runFF runs one ffmpeg invocation (in dir when set), mapping -progress to
// job progress when durSec > 0.
func runFF(ctx context.Context, job *core.JobContext, ffmpeg string, args []string, dir string, durSec float64, label string) error {
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
			if durSec <= 0 {
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
			job.Log(core.StreamStderr, l)
			mu.Lock()
			lastStderr = l
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("render cancelled: %w", ctxErr)
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
	return os.Remove(src)
}
