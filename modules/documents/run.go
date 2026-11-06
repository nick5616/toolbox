package documents

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
	"toolbox/core/deps"
	"toolbox/core/proc"
)

// inputTimeout bounds one conversion.
const inputTimeout = 10 * time.Minute

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("No file to convert", nil)
	}
	to, ok := lookupFormat(opts.To)
	if !ok {
		return core.ValidationError("Unknown format", map[string]string{"to": "Choose a format"})
	}
	input := job.Inputs[0]
	src, ok := inputFormat(strings.ToLower(filepath.Ext(input)))
	if !ok {
		if strings.EqualFold(filepath.Ext(input), ".pdf") {
			return core.ValidationError(ocrHint, nil).WithHint("Open OCR, then send its text here.")
		}
		return core.ValidationError("This file type can't be converted", nil)
	}

	pandoc, err := job.Tool(deps.Pandoc)
	if err != nil {
		return err
	}
	info := runInfo{Input: input, InputSpec: src}
	if opts.To == FormatPDF {
		if info.Typst, err = job.Tool(deps.Typst); err != nil {
			return err
		}
	}
	job.SetTitle(filepath.Base(input))

	dataDir := filepath.Join(job.TempDir, "pandoc-data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("create pandoc data dir: %w", err)
	}
	info.DataDir = dataDir
	info.Output = filepath.Join(job.TempDir, "result"+to.Ext)

	// Pick the final names first so extracted-media links stay valid.
	withMedia := opts.ExtractMedia && (opts.To == FormatMD || opts.To == FormatGFM || opts.To == FormatHTML)
	final, mediaName := pickNames(job.OutputDir, core.StemName(input), to.Ext, withMedia)
	info.MediaDir = mediaName
	if opts.To == FormatPDF || opts.To == FormatTypst {
		if info.MetaFile, err = marginMeta(job.TempDir, opts.MarginMm); err != nil {
			return err
		}
	}

	args, err := buildArgs(opts, info)
	if err != nil {
		return err
	}

	cache := filepath.Join(job.TempDir, "typst-packages")
	if m.toolsDir != "" {
		cache = filepath.Join(m.toolsDir, "typst", "packages")
	}
	if opts.To == FormatPDF {
		if err := os.MkdirAll(cache, 0o755); err != nil {
			return fmt.Errorf("create typst package cache: %w", err)
		}
	}

	rctx, cancel := context.WithTimeout(ctx, inputTimeout)
	defer cancel()

	var (
		mu    sync.Mutex
		lines []string
	)
	job.Progress(core.IndeterminateProgress, "Converting…")
	res, runErr := proc.Run(rctx, proc.Spec{
		Path: pandoc, Args: args, Dir: job.TempDir, Env: env(cache),
		OnStdout: func(l string) { job.Log(core.StreamStdout, l) },
		OnStderr: func(l string) {
			job.Log(core.StreamStderr, l)
			mu.Lock()
			lines = append(lines, l)
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("conversion cancelled: %w", ctxErr)
	}
	if errors.Is(rctx.Err(), context.DeadlineExceeded) {
		return core.Errorf(core.CodeToolFailed, "The conversion took too long and was stopped").
			WithHint("Try a smaller document.").WithCause(rctx.Err())
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return fmt.Errorf("run pandoc: %w", runErr)
		}
		mu.Lock()
		got := append([]string(nil), lines...)
		mu.Unlock()
		return mapFailure(res.ExitCode, got, opts.To).WithCause(runErr)
	}

	if err := moveFile(info.Output, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the converted file").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	if mediaName != "" {
		if fi, err := os.Stat(filepath.Join(job.TempDir, mediaName)); err == nil && fi.IsDir() {
			dst := filepath.Join(job.OutputDir, mediaName)
			if err := moveDir(filepath.Join(job.TempDir, mediaName), dst); err != nil {
				return core.Errorf(core.CodeToolFailed, "Couldn't save the extracted images").WithCause(err)
			}
			// Outputs are files only (core.NewOutput rejects folders), so the
			// folder is saved next to the document but not registered.
			job.Logf("Saved extracted images to %s", mediaName)
		}
	}
	job.Progress(1, "Saved "+filepath.Base(final))
	return nil
}

// moveDir renames the folder src to dst, falling back to a copy across
// volumes.
func moveDir(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return fmt.Errorf("relative path: %w", err)
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		return moveFile(p, target)
	})
	if err != nil {
		return fmt.Errorf("copy folder: %w", err)
	}
	_ = os.RemoveAll(src)
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
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("remove %s: %w", src, err)
	}
	return nil
}

// pickNames returns a free output path and, with media, a free
// "<name>_media" folder name sharing the output's stem.
func pickNames(dir, stem, ext string, media bool) (final, mediaName string) {
	for i := 0; ; i++ {
		s := stem
		if i > 0 {
			s = fmt.Sprintf("%s (%d)", stem, i)
		}
		final = filepath.Join(dir, s+ext)
		if _, err := os.Lstat(final); err == nil {
			continue
		}
		if !media {
			return final, ""
		}
		mediaName = s + "_media"
		if _, err := os.Lstat(filepath.Join(dir, mediaName)); err == nil {
			continue
		}
		return final, mediaName
	}
}
