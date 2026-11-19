package captions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/proc"
)

// Write into copies and rename copies (SPEC.md §5.4). Inputs are only ever
// read: every change is made on a copy inside the batch folder. Errors are
// per file and never stop the batch.

// outcome of write/rename.
type outcome struct {
	Written  int
	Failed   int
	Outputs  []string
	FirstErr string
}

func (o *outcome) fail(job *core.JobContext, input string, err error) {
	o.Failed++
	msg := fmt.Sprintf("%s: %s", filepath.Base(input), errText(err))
	if o.FirstErr == "" {
		o.FirstErr = errText(err)
	}
	job.Log(core.StreamSystem, msg)
}

func errText(err error) string {
	if ae := core.AsAppError(err); ae != nil && ae.Message != "" {
		return ae.Message
	}
	return err.Error()
}

// copyFile copies src to a new file dst (never overwriting) and keeps the
// modification time.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return err
	}
	_ = os.Chtimes(dst, fi.ModTime(), fi.ModTime())
	return nil
}

// uniqueIn reserves a unique file name in dir (the file is created empty so
// a later call can't pick it) and returns its path.
func uniqueIn(dir, stem, ext string) (string, error) {
	for range 1000 {
		p := core.UniquePath(dir, stem, ext)
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return p, f.Close()
		}
		if !errors.Is(err, os.ErrExist) {
			return "", err
		}
	}
	return "", errors.New("no free file name")
}

// exifValue makes a value safe for an ExifTool argument file (one argument
// per line).
func exifValue(s string) string { return oneLine(s) }

func captionText(f Fields, from Field) string {
	if from == FieldDescription {
		return f.Description
	}
	return f.Caption
}

// exifArgs are the argument-file lines that write the chosen fields (empty
// fields are skipped, never blanked).
func exifArgs(f Fields, wo WriteOptions) []string {
	args := []string{"-charset", "iptc=UTF8", "-codedcharacterset=utf8", "-m", "-overwrite_original"}
	add := func(tag, v string) {
		if v = exifValue(v); v != "" {
			args = append(args, "-"+tag+"="+v)
		}
	}
	if wo.Alt {
		add("XMP-iptcCore:AltTextAccessibility", f.Alt)
	}
	if wo.Description {
		add("XMP-iptcCore:ExtDescrAccessibility", f.Description)
	}
	if wo.Caption {
		c := captionText(f, wo.CaptionFrom)
		add("XMP-dc:Description", c)
		add("EXIF:ImageDescription", c)
		add("IPTC:Caption-Abstract", c)
	}
	if wo.Title {
		add("XMP-dc:Title", f.Title)
	}
	if wo.Keywords {
		for _, k := range f.Keywords {
			add("XMP-dc:Subject", k)
			add("IPTC:Keywords", k)
		}
	}
	if !wo.KeepLocation {
		args = append(args, "-gps:all=", "-xmp:GPS*=")
	}
	return args
}

// writeArgFile writes the argument file (UTF-8, LF).
func writeArgFile(dir string, lines []string) (string, error) {
	p := filepath.Join(dir, "exif-args.txt")
	return p, os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
}

// videoMetaArgs are FFmpeg's -metadata arguments for a video container.
func videoMetaArgs(f Fields, wo WriteOptions, ext string) []string {
	var args []string
	add := func(k, v string) {
		if v = oneLine(v); v != "" {
			args = append(args, "-metadata", k+"="+v)
		}
	}
	if wo.Title {
		add("title", f.Title)
	}
	if strings.EqualFold(ext, ".webm") { // WebM keeps a title only
		return args
	}
	switch {
	case wo.Description && f.Description != "":
		add("description", f.Description)
	case wo.Alt:
		add("description", f.Alt)
	}
	if wo.Caption {
		add("comment", captionText(f, wo.CaptionFrom))
	}
	if wo.Keywords && len(f.Keywords) > 0 {
		add("keywords", strings.Join(f.Keywords, ", "))
	}
	if !wo.KeepLocation {
		args = append(args, "-metadata", "location=", "-metadata", "location-eng=")
	}
	return args
}

// videoArgs is the whole stream-copy command (cwd = the TempDir).
func videoArgs(input, out string, meta []string, ext string) []string {
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-map", "0", "-c", "copy"}
	args = append(args, meta...)
	switch strings.ToLower(ext) {
	case ".mp4", ".mov", ".m4v":
		args = append(args, "-movflags", "use_metadata_tags")
	}
	return append(args, out)
}

// writeCopies copies each done item into <batch>/With captions/ and writes
// the chosen fields into the copy.
func (m *Module) writeCopies(ctx context.Context, job *core.JobContext, b Batch, wo WriteOptions) (outcome, error) {
	var res outcome
	dir := filepath.Join(b.Dir, WithCaptionsDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return res, core.Errorf(core.CodeInternal, "Couldn't create the folder for the copies").WithCause(err)
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return res, core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	var todo []int
	for i, it := range b.Items {
		if it.State == ItemDone {
			todo = append(todo, i)
		}
	}
	for n, i := range todo {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		it := b.Items[i]
		job.Progress(float64(n)/float64(max(len(todo), 1)), fmt.Sprintf("Writing %d of %d", n+1, len(todo)))
		var copyPath string
		var err error
		if isVideo(it.Input) {
			copyPath, err = m.writeVideoCopy(ctx, job, it, dir, wo)
		} else {
			copyPath, err = m.writeImageCopy(ctx, job, it, dir, wo)
		}
		if err != nil {
			if ctx.Err() != nil {
				return res, ctx.Err()
			}
			res.fail(job, it.Input, err)
			continue
		}
		if _, err := job.OutputFrom(copyPath, it.Input); err != nil {
			res.fail(job, it.Input, err)
			continue
		}
		res.Written++
		res.Outputs = append(res.Outputs, copyPath)
	}
	return res, nil
}

func (m *Module) writeImageCopy(ctx context.Context, job *core.JobContext, it Item, dir string, wo WriteOptions) (string, error) {
	exiftool, err := job.Tool(deps.ExifTool)
	if err != nil {
		return "", core.Errorf(core.CodeDependencyMissing, "Needs ExifTool to write into photos")
	}
	ext := filepath.Ext(it.Input)
	copyPath, err := uniqueIn(dir, core.StemName(it.Input), ext)
	if err != nil {
		return "", fmt.Errorf("create the copy: %w", err)
	}
	_ = os.Remove(copyPath)
	if err := copyFile(it.Input, copyPath); err != nil {
		_ = os.Remove(copyPath)
		return "", core.Errorf(core.CodeNotFound, "Couldn't copy the file").WithCause(err)
	}
	argFile, err := writeArgFile(job.TempDir, exifArgs(it.Fields, wo))
	if err != nil {
		_ = os.Remove(copyPath)
		return "", fmt.Errorf("write exiftool arguments: %w", err)
	}
	var stdout []string
	res, err := proc.Run(ctx, proc.Spec{
		Path:     exiftool,
		Args:     []string{"-charset", "utf8", "-charset", "filename=utf8", "-@", argFile, copyPath},
		Dir:      job.TempDir,
		OnStdout: func(l string) { stdout = append(stdout, l) },
	})
	updated := false
	for _, l := range stdout {
		if strings.Contains(l, "1 image files updated") {
			updated = true
		}
	}
	if err != nil || !updated {
		_ = os.Remove(copyPath)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		reason := "ExifTool couldn't write into this file"
		for i := len(res.StderrTail) - 1; i >= 0; i-- {
			if l := strings.TrimSpace(res.StderrTail[i]); strings.HasPrefix(l, "Error") {
				reason = "ExifTool: " + strings.TrimSpace(strings.TrimPrefix(l, "Error:"))
				break
			}
		}
		return "", core.Errorf(core.CodeToolFailed, "%s", reason)
	}
	return copyPath, nil
}

func (m *Module) writeVideoCopy(ctx context.Context, job *core.JobContext, it Item, dir string, wo WriteOptions) (string, error) {
	ffmpeg, err := job.Tool(deps.FFmpeg)
	if err != nil {
		return "", errNeedsFFmpeg
	}
	ext := filepath.Ext(it.Input)
	if _, err := os.Stat(it.Input); err != nil {
		return "", core.Errorf(core.CodeNotFound, "This file doesn't exist any more")
	}
	copyPath, err := uniqueIn(dir, core.StemName(it.Input), ext)
	if err != nil {
		return "", fmt.Errorf("create the copy: %w", err)
	}
	args := videoArgs(it.Input, copyPath, videoMetaArgs(it.Fields, wo, ext), ext)
	res, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: args, Dir: job.TempDir})
	if fi, serr := os.Stat(copyPath); err != nil || serr != nil || fi.Size() == 0 {
		_ = os.Remove(copyPath)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		reason := "FFmpeg couldn't write this video"
		if n := len(res.StderrTail); n > 0 {
			reason += ": " + strings.TrimSpace(res.StderrTail[n-1])
		}
		return "", core.Errorf(core.CodeToolFailed, "%s", reason)
	}
	return copyPath, nil
}

// renameCopies copies every done item that has a name into
// <batch>/Renamed/<name><ext>.
func (m *Module) renameCopies(ctx context.Context, job *core.JobContext, b Batch) (outcome, error) {
	var res outcome
	dir := filepath.Join(b.Dir, RenamedDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return res, core.Errorf(core.CodeInternal, "Couldn't create the folder for the copies").WithCause(err)
	}
	for i, it := range b.Items {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		if it.State != ItemDone {
			continue
		}
		job.Progress(float64(i)/float64(max(len(b.Items), 1)), fmt.Sprintf("Copying %d of %d", i+1, len(b.Items)))
		stem := cleanName(it.Fields.Name)
		if stem == "" {
			res.fail(job, it.Input, core.Errorf(core.CodeValidation, "This file has no name yet"))
			continue
		}
		ext := filepath.Ext(it.Input)
		dst, err := uniqueIn(dir, stem, ext)
		if err != nil {
			res.fail(job, it.Input, err)
			continue
		}
		_ = os.Remove(dst)
		if err := copyFile(it.Input, dst); err != nil {
			_ = os.Remove(dst)
			res.fail(job, it.Input, core.Errorf(core.CodeNotFound, "Couldn't copy the file").WithCause(err))
			continue
		}
		if _, err := job.OutputFrom(dst, it.Input); err != nil {
			res.fail(job, it.Input, err)
			continue
		}
		res.Written++
		res.Outputs = append(res.Outputs, dst)
	}
	return res, nil
}

// finishOutcome turns "nothing worked" into an error.
func finishOutcome(res outcome) error {
	if res.Written == 0 && res.Failed > 0 {
		return core.Errorf(core.CodeToolFailed, "Couldn't write any file: %s", res.FirstErr)
	}
	return nil
}
