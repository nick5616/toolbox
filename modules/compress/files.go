package compress

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"toolbox/core"
)

// OutputName is the stem of a compressed output: "<stem> (compressed)".
func OutputName(input string) string { return core.StemName(input) + " (compressed)" }

// PartName is the stem of one part of a split: "<stem> (part 2 of 3)".
func PartName(input string, part, parts int) string {
	return fmt.Sprintf("%s (part %d of %d)", core.StemName(input), part, parts)
}

// fileSize is a file's size in bytes.
func fileSize(path string) (int64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, fmt.Errorf("stat %s: %w", path, err)
	}
	return fi.Size(), nil
}

// saveOutput moves tmp (inside the job's TempDir) to <OutputDir>/<stem><ext>
// (never overwriting) and registers it in the library.
func saveOutput(job *core.JobContext, tmp, stem, ext string) (string, error) {
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		return "", fmt.Errorf("create output dir: %w", err)
	}
	final := core.UniquePath(job.OutputDir, stem, ext)
	if err := moveFile(tmp, final); err != nil {
		return "", core.Errorf(core.CodeToolFailed, "Couldn't save the compressed file").WithCause(err)
	}
	if _, err := registerFrom(job, final); err != nil {
		return "", fmt.Errorf("register output: %w", err)
	}
	return final, nil
}

// copyOutput copies a file that already fits into the output dir, unchanged,
// under its own name.
func copyOutput(job *core.JobContext, src string) (string, error) {
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		return "", fmt.Errorf("create output dir: %w", err)
	}
	final := core.UniquePath(job.OutputDir, core.StemName(src), filepath.Ext(src))
	if err := copyFile(src, final); err != nil {
		return "", core.Errorf(core.CodeToolFailed, "Couldn't copy the file").WithCause(err)
	}
	if _, err := registerFrom(job, final); err != nil {
		return "", fmt.Errorf("register output: %w", err)
	}
	return final, nil
}

// moveFile renames src to dst, falling back to copy+remove across volumes.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyFile(src, dst); err != nil {
		return err
	}
	return os.Remove(src)
}

// copyFile copies src to a new file dst (never overwriting).
func copyFile(src, dst string) error {
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
	return nil
}

// overLimit is the error when the best attempt still doesn't fit.
func overLimit(reached, limit int64, hint string) error {
	e := core.Errorf(core.CodeToolFailed, "Couldn't get it under %s (the smallest was %s)", FormatBytes(limit), FormatBytes(reached))
	if hint != "" {
		e = e.WithHint(hint)
	}
	return e
}

// registerFrom registers final in the library, made from the job's one input
// (Phase 19 lineage).
func registerFrom(job *core.JobContext, final string) (core.Output, error) {
	if len(job.Inputs) == 1 {
		return job.OutputFrom(final, job.Inputs[0])
	}
	return job.Output(final)
}
