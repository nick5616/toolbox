package packs

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// MoveRestartMessage is the final message of a successful move job.
const MoveRestartMessage = "Restart Toolbox to use the new folder"

// MoveResult is the job result of a tools-folder move.
type MoveResult struct {
	Path    string `json:"path"`
	Restart bool   `json:"restart"`
}

// checkMove validates a move target and returns it cleaned. The target is
// used as given (the picker already applied ResolveToolsDir).
func (s *Service) checkMove(path string) (string, error) {
	p := s.cfg.Paths
	if p.ToolsDirFromEnv {
		return "", core.ValidationError("The tools folder is set by TOOLBOX_TOOLS_DIR", nil)
	}
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil || strings.TrimSpace(path) == "" {
		return "", core.ValidationError("Pick a folder", map[string]string{"path": "Pick a folder"})
	}
	if err := s.checkToolsTarget(abs); err != nil {
		return "", err
	}
	if samePath(abs, p.ToolsDir) {
		return "", core.ValidationError("That is already the tools folder", map[string]string{"path": "That is already the tools folder"})
	}
	// Moving into the folder being moved (or out of it) would copy forever.
	if within(p.ToolsDir, abs) && !samePath(p.ToolsDir, p.SupportDir) {
		return "", errPickDifferent()
	}
	for _, d := range p.ToolsDirs() {
		if within(d, abs) {
			return "", errPickDifferent()
		}
	}
	return abs, nil
}

// moveModule is the hidden system-tools-move module (SPEC.md §7.3).
type moveModule struct{ s *Service }

func (m *moveModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: MoveModuleID, Name: "Move tools folder", Tagline: "Move downloaded tools to another folder",
		Icon: "folder-input", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1,
	}
}

func (m *moveModule) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) > 0 {
		return core.ValidationError("This task takes no inputs", nil)
	}
	o, err := core.DecodeOptionsJSON[MoveOptions](options)
	if err != nil {
		return err
	}
	_, err = m.s.checkMove(o.Path)
	return err
}

// plan is the set of files to copy.
type plan struct {
	dirs  []string // top-level folder names that exist
	files int
	bytes int64
}

func scanTools(root string, names []string) (plan, error) {
	var pl plan
	for _, name := range names {
		dir := filepath.Join(root, name)
		if _, err := os.Lstat(dir); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return pl, err
		}
		pl.dirs = append(pl.dirs, name)
		err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			pl.files++
			if d.Type().IsRegular() {
				if fi, err := d.Info(); err == nil {
					pl.bytes += fi.Size()
				}
			}
			return nil
		})
		if err != nil {
			return pl, err
		}
	}
	return pl, nil
}

func (m *moveModule) Run(ctx context.Context, job *core.JobContext) error {
	s := m.s
	o, err := core.DecodeOptions[MoveOptions](job)
	if err != nil {
		return err
	}
	target, err := s.checkMove(o.Path)
	if err != nil {
		return err
	}
	if s.otherJobsRunning(job.ID) {
		return core.Errorf(core.CodeConflict, "Wait for running jobs to finish")
	}
	p := s.cfg.Paths
	job.SetTitle("Move tools folder")
	job.Progress(core.IndeterminateProgress, "Stopping the AI engine")
	if s.cfg.StopEngines != nil {
		s.cfg.StopEngines()
	}

	src, err := scanTools(p.ToolsDir, toolsSubdirNames)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't read the current tools folder").WithCause(err)
	}
	// Refuse to merge into existing tool files.
	for _, name := range src.dirs {
		if ents, err := os.ReadDir(filepath.Join(target, name)); err == nil && len(ents) > 0 {
			return core.ValidationError("The new folder already contains tools", nil).
				WithHint("Pick an empty folder")
		}
	}
	targetExisted := false
	if _, err := os.Stat(target); err == nil {
		targetExisted = true
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the new folder").WithCause(err)
	}
	cleanupPartial := func() {
		for _, name := range src.dirs {
			_ = os.RemoveAll(filepath.Join(target, name))
		}
		if !targetExisted {
			_ = os.Remove(target)
		}
	}

	var done int64
	cp := &copier{ctx: ctx, total: max(src.bytes, 1), done: &done, report: func(frac float64) {
		job.Progress(0.95*frac, fmt.Sprintf("Copying · %s of %s", fmtBytes(done), fmtBytes(src.bytes)))
	}}
	job.Logf("Copying %d files (%s) from %s to %s", src.files, fmtBytes(src.bytes), p.ToolsDir, target)
	for _, name := range src.dirs {
		if err := cp.copyTree(filepath.Join(p.ToolsDir, name), filepath.Join(target, name)); err != nil {
			cleanupPartial()
			if ctx.Err() != nil {
				return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(ctx.Err())
			}
			return core.Errorf(core.CodeInternal, "Couldn't copy the tools").WithCause(err).
				WithHint("Check there is enough free space and try again")
		}
	}

	job.Progress(0.96, "Verifying")
	dst, err := scanTools(target, src.dirs)
	if err != nil || dst.files != src.files || dst.bytes != src.bytes {
		cleanupPartial()
		return core.Errorf(core.CodeInternal, "The copy didn't match the original (%d of %d files)", dst.files, src.files).
			WithCause(err).WithHint("Try again")
	}

	if err := rewriteVenvHome(filepath.Join(target, "sidecar", ".venv", "pyvenv.cfg"), p.PythonDir, filepath.Join(target, "python")); err != nil {
		cleanupPartial()
		return core.Errorf(core.CodeInternal, "Couldn't update the AI engine for the new folder").WithCause(err)
	}

	job.Progress(0.98, "Saving the new location")
	if err := writeMarker(target); err != nil {
		cleanupPartial()
		return core.Errorf(core.CodeInternal, "Couldn't mark the new folder").WithCause(err)
	}
	if err := writeFileAtomic(filepath.Join(p.SupportDir, core.ToolsMoveCleanupFile), []byte(filepath.Clean(p.ToolsDir)+"\n")); err != nil {
		cleanupPartial()
		return core.Errorf(core.CodeInternal, "Couldn't save the move").WithCause(err)
	}
	if err := core.WriteToolsPointer(p.SupportDir, target); err != nil {
		cleanupPartial()
		_ = os.Remove(filepath.Join(p.SupportDir, core.ToolsMoveCleanupFile))
		return core.Errorf(core.CodeInternal, "Couldn't save the new folder").WithCause(err)
	}
	_ = job.SetResult(MoveResult{Path: target, Restart: true})
	job.Progress(1, MoveRestartMessage)
	return nil
}

// copier copies trees with byte progress, honouring cancellation.
type copier struct {
	ctx    context.Context
	total  int64
	done   *int64
	report func(frac float64)
}

func (c *copier) copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := c.ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(out, 0o755)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, out)
		case d.Type().IsRegular():
			return c.copyFile(path, out)
		}
		return nil // sockets, devices: not part of a tools folder
	})
}

func (c *copier) copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	buf := make([]byte, 1<<20)
	for {
		if err := c.ctx.Err(); err != nil {
			out.Close()
			return err
		}
		n, rerr := in.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				out.Close()
				return werr
			}
			*c.done += int64(n)
			c.report(float64(*c.done) / float64(c.total))
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			return rerr
		}
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, fi.ModTime(), fi.ModTime())
}

// rewriteVenvHome points the `home` line of a venv's pyvenv.cfg at the new
// CPython folder when it was inside oldPython. A missing file is fine (no
// engine installed).
func rewriteVenvHome(cfgPath, oldPython, newPython string) error {
	f, err := os.Open(cfgPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	f.Close()
	if err := sc.Err(); err != nil {
		return err
	}
	changed := false
	for i, ln := range lines {
		key, val, ok := strings.Cut(ln, "=")
		if !ok || strings.TrimSpace(key) != "home" {
			continue
		}
		home := strings.TrimSpace(val)
		if !within(oldPython, home) {
			continue
		}
		rel, err := filepath.Rel(filepath.Clean(oldPython), filepath.Clean(home))
		if err != nil {
			// Case-insensitive prefix (Windows): fall back to a length cut.
			rel = strings.TrimLeft(home[len(filepath.Clean(oldPython)):], `\/`)
		}
		lines[i] = "home = " + filepath.Join(newPython, rel)
		changed = true
	}
	if !changed {
		return nil
	}
	return writeFileAtomic(cfgPath, []byte(strings.Join(lines, "\n")+"\n"))
}
