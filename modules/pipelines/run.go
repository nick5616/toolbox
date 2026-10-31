package pipelines

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// Limits (SPEC.md §7).
const (
	maxPromptChars = 8000
	maxSystemChars = 4000
	maxChatFields  = 12
	maxTableCols   = 30
	// maxOpsPerJob keeps one job's result under core.MaxResultBytes.
	maxOpsPerJob = 100
)

// jobResult is the result every built-in job records (SPEC.md §7): the files
// it produced or carried and its variables. StepOutputs reads it back.
type jobResult struct {
	Files []core.RunFile    `json:"files"`
	Vars  map[string]string `json:"vars,omitempty"`
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	switch o.Action {
	case ActionRename:
		if len(o.Rename) == 0 {
			return core.ValidationError("There is nothing to rename", nil)
		}
		for _, op := range o.Rename {
			if op.Path == "" {
				return core.ValidationError("A file to rename has no path", nil)
			}
		}
	case ActionChat:
		if o.Chat == nil {
			return core.ValidationError("The chat step has no settings", nil)
		}
		return validateChatJob(*o.Chat)
	case ActionTable:
		t := o.Table
		if t == nil {
			return core.ValidationError("The table step has no settings", nil)
		}
		if len(t.Header) < 1 || len(t.Header) > maxTableCols {
			return core.ValidationError(fmt.Sprintf("A table has 1 to %d columns", maxTableCols), nil)
		}
		for i, r := range t.Rows {
			if len(r) != len(t.Header) {
				return core.ValidationError(fmt.Sprintf("Row %d has %d cells but the table has %d columns", i+1, len(r), len(t.Header)), nil)
			}
		}
	case ActionZip:
		if o.Zip == nil || len(o.Zip.Files) == 0 {
			return core.ValidationError("There are no files to zip", nil)
		}
	case ActionCopy:
		c := o.Copy
		if c == nil || len(c.Files) == 0 {
			return core.ValidationError("There are no files to copy", nil)
		}
		if err := m.checkFolder(c.Folder, false); err != nil {
			return err
		}
	default:
		return core.ValidationError(fmt.Sprintf("Unknown pipeline action %q", o.Action), nil)
	}
	return nil
}

// checkFolder applies the Copy to folder rules (SPEC.md §7.2): absolute,
// optionally existing, and not inside the Library.
func (m *Module) checkFolder(folder string, mustExist bool) error {
	if strings.TrimSpace(folder) == "" {
		return core.ValidationError("Choose a folder to copy to", map[string]string{"folder": "Choose a folder"})
	}
	if !filepath.IsAbs(folder) {
		return core.ValidationError("The folder must be a full path", map[string]string{"folder": "Use the Choose button"})
	}
	if mustExist {
		st, err := os.Stat(folder)
		if err != nil {
			return core.ValidationError("That folder doesn't exist", map[string]string{"folder": "Choose another folder"})
		}
		if !st.IsDir() {
			return core.ValidationError("That isn't a folder", map[string]string{"folder": "Choose a folder"})
		}
	}
	if m.libraryDir != nil && isInside(folder, m.libraryDir()) {
		return core.ValidationError("Pick a folder outside your Library", map[string]string{"folder": "Pick a folder outside your Library"})
	}
	return nil
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := m.Validate(job.Inputs, job.Options); err != nil {
		return err
	}
	switch o.Action {
	case ActionRename:
		return m.runRename(ctx, job, o)
	case ActionChat:
		return m.runChat(ctx, job, o)
	case ActionTable:
		return m.runTable(ctx, job, o)
	case ActionZip:
		return m.runZip(ctx, job, o)
	default:
		return m.runCopy(ctx, job, o)
	}
}

// outDir is <library>/Pipelines/<pipeline name cleaned>, created.
func outDir(job *core.JobContext, pipelineName string) (string, error) {
	name := cleanName(pipelineName)
	if name == "" {
		name = "Pipeline"
	}
	dir := filepath.Join(job.OutputDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating %s: %w", dir, err)
	}
	return dir, nil
}

func runFile(path string, role, roleLabel, outputID string) core.RunFile {
	return core.RunFile{Path: path, Name: filepath.Base(path), Kind: core.KindForPath(path), Role: role, RoleLabel: roleLabel, OutputID: outputID}
}

// addOutput registers path in the Library and describes it for the result.
func addOutput(job *core.JobContext, path, role, roleLabel string) (core.RunFile, error) {
	out, err := job.Output(path)
	if err != nil {
		return core.RunFile{}, err
	}
	return runFile(path, role, roleLabel, out.ID), nil
}

// ---- rename ---------------------------------------------------------------

func (m *Module) runRename(ctx context.Context, job *core.JobContext, o Options) error {
	dir, err := outDir(job, o.Pipeline)
	if err != nil {
		return err
	}
	n := len(o.Rename)
	files := make([]core.RunFile, 0, n)
	for i, op := range o.Rename {
		if err := ctx.Err(); err != nil {
			return err
		}
		job.Progress(float64(i)/float64(n), fmt.Sprintf("Renaming %d of %d", i+1, n))
		stem := cleanName(op.Name)
		if stem == "" {
			stem = core.StemName(op.Path)
		}
		ext := filepath.Ext(op.Path)
		var rf core.RunFile
		if op.Move {
			rf, err = m.moveOne(ctx, job, op, stem, ext)
		} else {
			rf, err = m.copyOne(ctx, job, dir, op, stem, ext)
		}
		if err != nil {
			return err
		}
		files = append(files, rf)
	}
	return job.SetResult(jobResult{Files: files})
}

// moveOne renames a file this run made, in place, and repoints its Library
// record.
func (m *Module) moveOne(ctx context.Context, job *core.JobContext, op RenameOp, stem, ext string) (core.RunFile, error) {
	if _, err := os.Stat(op.Path); err != nil {
		return core.RunFile{}, core.ValidationError(filepath.Base(op.Path)+" isn't there any more", nil).WithCause(err)
	}
	dir := filepath.Dir(op.Path)
	want := filepath.Join(dir, stem+ext)
	target := op.Path
	switch {
	case want == op.Path:
		// already named so
	case strings.EqualFold(want, op.Path):
		// only the case changes: rename directly, there is nothing to collide with
		if err := os.Rename(op.Path, want); err != nil {
			return core.RunFile{}, fmt.Errorf("renaming %s: %w", filepath.Base(op.Path), err)
		}
		target = want
	default:
		p, err := reserve(dir, stem, ext)
		if err != nil {
			return core.RunFile{}, err
		}
		if err := os.Rename(op.Path, p); err != nil {
			_ = os.Remove(p)
			return core.RunFile{}, fmt.Errorf("renaming %s: %w", filepath.Base(op.Path), err)
		}
		target = p
	}
	if target != op.Path && op.OutputID != "" && m.outputs != nil {
		out, err := m.outputs.MoveOutput(ctx, op.OutputID, target)
		if err != nil {
			_ = os.Rename(target, op.Path)
			return core.RunFile{}, fmt.Errorf("updating the Library record of %s: %w", filepath.Base(op.Path), err)
		}
		if m.em != nil {
			m.em.Emit(core.EventLibraryAdded, out)
		}
	}
	job.Logf("Renamed %s to %s", filepath.Base(op.Path), filepath.Base(target))
	return runFile(target, op.Role, op.RoleLabel, op.OutputID), nil
}

// copyOne copies one of the run's own inputs into dir under its new name.
func (m *Module) copyOne(ctx context.Context, job *core.JobContext, dir string, op RenameOp, stem, ext string) (core.RunFile, error) {
	p, err := reserve(dir, stem, ext)
	if err != nil {
		return core.RunFile{}, err
	}
	if err := copyInto(ctx, op.Path, p); err != nil {
		return core.RunFile{}, err
	}
	job.Logf("Copied %s as %s", filepath.Base(op.Path), filepath.Base(p))
	return addOutput(job, p, op.Role, op.RoleLabel)
}

// ---- copy -----------------------------------------------------------------

func (m *Module) runCopy(ctx context.Context, job *core.JobContext, o Options) error {
	c := o.Copy
	if err := os.MkdirAll(c.Folder, 0o755); err != nil {
		return core.ValidationError("Couldn't create the folder "+c.Folder, nil).WithCause(err)
	}
	n := len(c.Files)
	files := make([]core.RunFile, 0, n)
	for i, src := range c.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		job.Progress(float64(i)/float64(n), fmt.Sprintf("Copying %d of %d", i+1, n))
		ext := filepath.Ext(src)
		dst, err := reserve(c.Folder, strings.TrimSuffix(filepath.Base(src), ext), ext)
		if err != nil {
			return err
		}
		if err := copyInto(ctx, src, dst); err != nil {
			return err
		}
		job.Logf("Copied %s to %s", filepath.Base(src), filepath.Base(dst))
		var cf CarriedFile
		if i < len(c.Carry) {
			cf = c.Carry[i]
		}
		files = append(files, runFile(src, cf.Role, cf.RoleLabel, cf.OutputID))
	}
	return job.SetResult(jobResult{Files: files})
}

// ---- table ----------------------------------------------------------------

func (m *Module) runTable(ctx context.Context, job *core.JobContext, o Options) error {
	t := o.Table
	dir, err := outDir(job, o.Pipeline)
	if err != nil {
		return err
	}
	stem := cleanName(t.Name)
	if stem == "" {
		stem = "Table"
	}
	p, err := reserve(dir, stem, ".csv")
	if err != nil {
		return err
	}
	if err := writeCSV(p, t.Header, t.Rows); err != nil {
		_ = os.Remove(p)
		return err
	}
	rf, err := addOutput(job, p, "table", "Table")
	if err != nil {
		return err
	}
	return job.SetResult(jobResult{Files: []core.RunFile{rf}})
}

// writeCSV writes RFC 4180 CSV (CRLF) with a UTF-8 byte order mark so
// spreadsheet apps read accents.
func writeCSV(path string, header []string, rows [][]string) (err error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC|os.O_CREATE, 0o644)
	if err != nil {
		return fmt.Errorf("writing %s: %w", filepath.Base(path), err)
	}
	defer func() {
		if cerr := f.Close(); err == nil && cerr != nil {
			err = fmt.Errorf("writing %s: %w", filepath.Base(path), cerr)
		}
	}()
	if _, err := f.WriteString("\xEF\xBB\xBF"); err != nil {
		return err
	}
	w := csv.NewWriter(f)
	w.UseCRLF = true
	if err := w.Write(header); err != nil {
		return err
	}
	for _, r := range rows {
		if err := w.Write(r); err != nil {
			return err
		}
	}
	w.Flush()
	return w.Error()
}

// ---- zip ------------------------------------------------------------------

// storedExts are already compressed: zipping them again only costs time.
var storedExts = map[string]bool{
	".mp3": true, ".m4a": true, ".aac": true, ".ogg": true, ".opus": true, ".flac": true, ".wma": true,
	".mp4": true, ".m4v": true, ".mov": true, ".mkv": true, ".webm": true, ".avi": true,
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true, ".heic": true, ".avif": true,
	".zip": true, ".pdf": true, ".7z": true, ".gz": true, ".rar": true,
}

func (m *Module) runZip(ctx context.Context, job *core.JobContext, o Options) (err error) {
	z := o.Zip
	dir, err := outDir(job, o.Pipeline)
	if err != nil {
		return err
	}
	stem := cleanName(z.Name)
	if stem == "" {
		stem = "Files"
	}
	p, err := reserve(dir, stem, ".zip")
	if err != nil {
		return err
	}
	out, err := os.OpenFile(p, os.O_WRONLY|os.O_TRUNC|os.O_CREATE, 0o644)
	if err != nil {
		return fmt.Errorf("writing %s: %w", filepath.Base(p), err)
	}
	defer func() {
		if err != nil {
			_ = out.Close()
			_ = os.Remove(p)
		}
	}()
	zw := zip.NewWriter(out)
	used := map[string]bool{}
	n := len(z.Files)
	for i, src := range z.Files {
		if err = ctx.Err(); err != nil {
			return err
		}
		job.Progress(float64(i)/float64(n), fmt.Sprintf("Adding %d of %d", i+1, n))
		if err = addToZip(ctx, zw, src, used); err != nil {
			return err
		}
	}
	if err = zw.Close(); err != nil {
		return fmt.Errorf("finishing %s: %w", filepath.Base(p), err)
	}
	if err = out.Close(); err != nil {
		return fmt.Errorf("writing %s: %w", filepath.Base(p), err)
	}
	rf, err := addOutput(job, p, "zip", "Zip")
	if err != nil {
		return err
	}
	return job.SetResult(jobResult{Files: []core.RunFile{rf}})
}

// entryName makes name unique within the archive: "a.wav", "a (2).wav", …
func entryName(used map[string]bool, name string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	cand := name
	for n := 2; used[strings.ToLower(cand)]; n++ {
		cand = fmt.Sprintf("%s (%d)%s", stem, n, ext)
	}
	used[strings.ToLower(cand)] = true
	return cand
}

func addToZip(ctx context.Context, zw *zip.Writer, src string, used map[string]bool) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("opening %s: %w", filepath.Base(src), err)
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return fmt.Errorf("reading %s: %w", filepath.Base(src), err)
	}
	if st.IsDir() {
		return core.ValidationError(filepath.Base(src)+" is a folder, not a file", nil)
	}
	h, err := zip.FileInfoHeader(st)
	if err != nil {
		return fmt.Errorf("reading %s: %w", filepath.Base(src), err)
	}
	h.Name = entryName(used, filepath.Base(src))
	h.Method = zip.Deflate
	if storedExts[strings.ToLower(filepath.Ext(src))] {
		h.Method = zip.Store
	}
	w, err := zw.CreateHeader(h)
	if err != nil {
		return fmt.Errorf("adding %s: %w", filepath.Base(src), err)
	}
	if _, err := io.Copy(w, ctxReader{ctx, in}); err != nil {
		return fmt.Errorf("adding %s: %w", filepath.Base(src), err)
	}
	return nil
}
