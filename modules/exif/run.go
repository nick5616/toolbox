package exif

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/deps"
)

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if !slices.Contains([]Action{ActionStripLocation, ActionStripAll, ActionEdit}, opts.Action) {
		return core.ValidationError("Choose what to do with the metadata", map[string]string{"action": "Unknown action"})
	}
	fields := map[string]string{}
	for i, in := range inputs {
		key := fmt.Sprintf("inputs.%d", i)
		switch {
		case isRaw(in):
			fields[key] = "RAW files are read-only here"
		case !isWritable(in):
			fields[key] = fmt.Sprintf("Metadata can't be changed in %s files", strings.ToLower(filepath.Ext(in)))
		}
	}
	if len(fields) > 0 {
		return core.ValidationError("Some files can't be changed", fields)
	}
	if opts.Action == ActionEdit {
		if bad := validateFields(opts.Fields); len(bad) > 0 {
			return core.ValidationError("Check the fields", bad)
		}
	}
	return nil
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if _, err := job.Tool(deps.ExifTool); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("No file to process", nil)
	}
	var res Result
	var removed int
	for i, in := range job.Inputs {
		if err := ctx.Err(); err != nil {
			return cancelErr(err)
		}
		if isRaw(in) {
			return core.ValidationError("RAW files are read-only here", nil)
		}
		job.Progress(float64(i)/float64(len(job.Inputs)), "Working on "+filepath.Base(in))
		out, n, err := m.process(ctx, job, opts, in)
		if err != nil {
			return err
		}
		if res.Output == "" {
			res = Result{Action: opts.Action, Output: out}
		}
		removed += n
	}
	res.RemovedTags = removed
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, summary(opts, res.RemovedTags))
	return nil
}

func summary(o Options, removed int) string {
	switch o.Action {
	case ActionStripLocation:
		return fmt.Sprintf("Removed %d location %s", removed, plural(removed, "tag", "tags"))
	case ActionStripAll:
		return fmt.Sprintf("Removed %d %s", removed, plural(removed, "tag", "tags"))
	default:
		n := len(o.Fields)
		return fmt.Sprintf("Updated %d %s", n, plural(n, "field", "fields"))
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func cancelErr(err error) error {
	return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(err)
}

// process writes one new file and returns its path and the tag count drop.
func (m *Module) process(ctx context.Context, job *core.JobContext, opts Options, in string) (string, int, error) {
	before, err := m.tagCount(ctx, in)
	if err != nil {
		return "", 0, err
	}
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		return "", 0, core.Errorf(core.CodeInternal, "Couldn't create the output folder").WithCause(err)
	}
	out := core.UniquePath(job.OutputDir, core.StemName(in)+opts.Action.suffix(), filepath.Ext(in))
	args := append(buildArgs(opts), "-charset", "filename=utf8", "-o", out, in)
	job.Logf("exiftool %s", strings.Join(args, " "))
	_, err = m.sess.Exec(ctx, args...)
	if err != nil {
		_ = os.Remove(out)
		return "", 0, m.toolErr(ctx, "ExifTool couldn't write the new file", err)
	}
	if fi, serr := os.Stat(out); serr != nil || fi.Size() == 0 {
		_ = os.Remove(out)
		return "", 0, core.Errorf(core.CodeToolFailed, "ExifTool didn't create the new file")
	}
	after, err := m.tagCount(ctx, out)
	if err != nil {
		_ = os.Remove(out)
		return "", 0, err
	}
	if _, err := job.Output(out); err != nil {
		return "", 0, fmt.Errorf("register output: %w", err)
	}
	return out, max(before-after, 0), nil
}

// toolErr maps session errors to user-facing errors.
func (m *Module) toolErr(ctx context.Context, what string, err error) error {
	if ctx.Err() != nil {
		return cancelErr(ctx.Err())
	}
	var ae *core.AppError
	if errors.As(err, &ae) {
		return ae
	}
	var ee *ExecError
	if errors.As(err, &ee) {
		return core.Errorf(core.CodeToolFailed, "%s", what).WithHint(ee.Stderr).WithCause(err)
	}
	return core.Errorf(core.CodeToolFailed, "%s", what).WithCause(err)
}

// tagCount counts a file's tags (see countTags).
func (m *Module) tagCount(ctx context.Context, path string) (int, error) {
	out, err := m.sess.Exec(ctx, "-j", "-G1", "-a", "-n", "-charset", "filename=utf8", path)
	entries, perr := parseJSON(sanitizeJSON(out))
	if perr != nil {
		if err != nil {
			return 0, m.toolErr(ctx, "ExifTool couldn't read the file", err)
		}
		return 0, core.Errorf(core.CodeToolFailed, "ExifTool couldn't read the file").WithCause(perr)
	}
	return countTags(entries), nil
}

func (m *Module) read(ctx context.Context, path string) (MetadataView, error) {
	if !filepath.IsAbs(path) {
		return MetadataView{}, core.Errorf(core.CodeNotFound, "File not found")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return MetadataView{}, core.Errorf(core.CodeNotFound, "File not found").WithCause(err)
	}
	if !fi.Mode().IsRegular() {
		return MetadataView{}, core.ValidationError("Not a file", nil)
	}
	if ext := strings.ToLower(filepath.Ext(path)); !slices.Contains(Accepts(), ext) {
		return MetadataView{}, core.ValidationError(fmt.Sprintf("Unsupported file type (%s)", ext), nil)
	}
	pretty, err := m.readPass(ctx, path, false)
	if err != nil {
		return MetadataView{}, err
	}
	num, err := m.readPass(ctx, path, true)
	if err != nil {
		return MetadataView{}, err
	}
	return buildView(path, fi.Size(), pretty, num), nil
}

// readPass runs `-j -G1 -struct` (numeric adds -n) for one file. The display
// pass is human-readable; the numeric pass gives decimal GPS values.
func (m *Module) readPass(ctx context.Context, path string, numeric bool) ([]tagEntry, error) {
	args := []string{"-j", "-G1", "-struct"}
	if numeric {
		args = append(args, "-n")
	}
	args = append(args, "-charset", "filename=utf8", path)
	out, err := m.sess.Exec(ctx, args...)
	entries, perr := parseJSON(sanitizeJSON(out))
	if perr != nil {
		if err != nil {
			return nil, m.toolErr(ctx, "ExifTool couldn't read this file", err)
		}
		return nil, core.Errorf(core.CodeToolFailed, "ExifTool couldn't read this file").WithCause(perr)
	}
	if ctx.Err() != nil {
		return nil, cancelErr(ctx.Err())
	}
	return entries, nil
}
