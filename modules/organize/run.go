package organize

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
)

// Summary is the job's result (core.JobContext.SetResult).
type Summary struct {
	Root       string `json:"root"`
	Report     string `json:"report"`
	Copied     int    `json:"copied"`     // files copied to their group folders
	Duplicates int    `json:"duplicates"` // files found to be duplicates
	Skipped    int    `json:"skipped"`    // duplicates not copied (dupAction skip)
	Failed     int    `json:"failed"`
	Folders    int    `json:"folders"`
}

// ctxReader stops a copy when ctx is cancelled.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// copyFile copies src to dst (which must not exist), keeping the modified
// time. The copy is written under a temporary name and renamed when whole,
// so a cancel never leaves a half-written file with the real name.
func copyFile(ctx context.Context, src, dst string, mod time.Time) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create folder for %s: %w", dst, err)
	}
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmp, err)
	}
	_, cerr := io.Copy(out, ctxReader{ctx, in})
	if clerr := out.Close(); cerr == nil {
		cerr = clerr
	}
	if cerr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("copy %s: %w", src, cerr)
	}
	if _, err := os.Stat(dst); err == nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("%s already exists", dst)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("finish %s: %w", dst, err)
	}
	if !mod.IsZero() {
		_ = os.Chtimes(dst, mod, mod)
	}
	return nil
}

// runFolder creates a fresh, empty run folder under base.
func runFolder(base, name string) (string, error) {
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", core.ValidationError("Couldn't create the destination folder", map[string]string{"destination": "Couldn't create this folder"}).WithCause(err)
	}
	for n := 1; n < 1000; n++ {
		cand := name
		if n > 1 {
			cand = fmt.Sprintf("%s (%d)", name, n)
		}
		root := filepath.Join(base, cand)
		err := os.Mkdir(root, 0o755)
		if err == nil {
			return root, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", core.ValidationError("Couldn't create the result folder", nil).WithCause(err)
		}
	}
	return "", core.ValidationError("Couldn't find a free result folder name", nil)
}

// defaultRunName names a run by its start time.
func defaultRunName(now time.Time) string { return "Organized " + now.Format("2006-01-02 15.04.05") }

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := m.validate(job.Inputs, job.Options); err != nil {
		return err
	}
	base := job.OutputDir
	if opts.Destination != "" {
		base = opts.Destination
	}
	if base == "" {
		return core.ValidationError("There's no folder to put the result in", nil)
	}
	name := sanitizeComponent(opts.RunName)
	if opts.RunName == "" {
		name = defaultRunName(time.Now())
	}
	// The copies' folder must be separate from every input (a fresh folder
	// inside an input folder would be organized into itself).
	if err := checkRoot(filepath.Join(base, name), job.Inputs); err != nil {
		return err
	}

	var read readMetaFunc
	if exe := toolPath(job); exe != "" {
		read = exiftoolReader(exe)
	} else {
		job.Logf("ExifTool isn't installed: using the files' modified dates")
	}
	pl, err := newPlanner(read, job.Progress).build(ctx, job.Inputs, opts)
	if err != nil {
		return err
	}

	root, err := runFolder(base, name)
	if err != nil {
		return err
	}
	job.SetTitle(filepath.Base(root))
	sum, err := copyPlan(ctx, job, pl, root)
	if err != nil {
		return err
	}
	if err := job.SetResult(sum); err != nil {
		return err
	}
	if sum.Failed > 0 && sum.Copied == 0 && sum.Duplicates-sum.Skipped == 0 {
		return core.Errorf(core.CodeToolFailed, "Couldn't copy any file").WithHint("Check the destination folder has room and can be written to.")
	}
	job.Progress(1, fmt.Sprintf("%d copied", sum.Copied+sum.Duplicates-sum.Skipped))
	return nil
}

// toolPath resolves ExifTool through the job, or "".
func toolPath(job *core.JobContext) string {
	p, err := job.Tool(deps.ExifTool)
	if err != nil {
		return ""
	}
	return p
}

// copyPlan copies every planned file into root, writes the report and
// registers outputs (kept files, duplicates, then the report).
func copyPlan(ctx context.Context, job *core.JobContext, pl *plan, root string) (Summary, error) {
	sum := Summary{Root: root}
	folders := map[string]bool{}
	var copiedAt []*entry
	total := 0
	for _, e := range pl.Entries {
		if e.Dest != "" {
			total++
		}
	}
	done := 0
	failed := map[*entry]bool{}
	for _, e := range pl.Entries {
		if err := ctx.Err(); err != nil {
			return sum, err
		}
		if e.DupOf >= 0 {
			sum.Duplicates++
		}
		if e.Dest == "" {
			sum.Skipped++
			continue
		}
		dst := filepath.Join(root, filepath.FromSlash(e.Dest))
		if err := copyFile(ctx, e.Src, dst, e.ModTime); err != nil {
			if ctx.Err() != nil {
				return sum, ctx.Err()
			}
			sum.Failed++
			failed[e] = true
			job.Log(core.StreamStderr, fmt.Sprintf("Couldn't copy %s: %v", filepath.Base(e.Src), err))
			done++
			continue
		}
		done++
		copiedAt = append(copiedAt, e)
		folders[filepath.ToSlash(filepath.Dir(e.Dest))] = true
		if e.DupOf < 0 {
			sum.Copied++
		}
		job.Progress(copyFrom+(1-copyFrom)*0.95*float64(done)/float64(max(total, 1)), fmt.Sprintf("Copying · %d of %d", done, total))
	}
	sum.Folders = len(folders)

	report := filepath.Join(root, ReportName)
	if err := writeReport(report, pl, root, failed); err != nil {
		return sum, err
	}
	sum.Report = report

	// Register outputs: kept files first, then duplicates, then the report.
	for _, dup := range []bool{false, true} {
		for _, e := range copiedAt {
			if (e.DupOf >= 0) != dup {
				continue
			}
			if _, err := job.Output(filepath.Join(root, filepath.FromSlash(e.Dest))); err != nil {
				return sum, fmt.Errorf("register %s: %w", e.Dest, err)
			}
		}
	}
	if _, err := job.Output(report); err != nil {
		return sum, fmt.Errorf("register report: %w", err)
	}
	return sum, nil
}

// writeReport writes report.csv: original path, copy, group and duplicate-of.
func writeReport(path string, pl *plan, root string, failed map[*entry]bool) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create report: %w", err)
	}
	// A byte-order mark lets Excel read non-ASCII names correctly.
	_, werr := f.Write([]byte{0xEF, 0xBB, 0xBF})
	w := csv.NewWriter(f)
	if werr == nil {
		werr = w.Write([]string{"original", "copy", "group", "duplicate_of", "match"})
	}
	for _, e := range pl.Entries {
		if werr != nil {
			break
		}
		cp, dupOf, match := "", "", ""
		if e.Dest != "" && !failed[e] {
			cp = filepath.Join(root, filepath.FromSlash(e.Dest))
		}
		if e.DupOf >= 0 {
			dupOf = pl.keeper(e).Src
			match = "exact"
			if e.Similar {
				match = "similar"
			}
		}
		werr = w.Write([]string{e.Src, cp, e.Group, dupOf, match})
	}
	w.Flush()
	if werr == nil {
		werr = w.Error()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return fmt.Errorf("write report: %w", werr)
	}
	return nil
}
