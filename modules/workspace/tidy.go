package workspace

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
	ws "toolbox/core/workspace"
)

// TidyFile is one file Tidy would move to the trash.
type TidyFile struct {
	Path string // absolute
	Size int64
}

// PlanTidy lists every library file that isn't in the baseline manifest and
// isn't under a keep folder. Hidden files, links and non-regular files are
// never listed, and links are never followed. Sorted by path.
func PlanTidy(ctx context.Context, info ws.Info) ([]TidyFile, error) {
	lib := ws.LibraryDirOf(info.Root)
	manifest, _, err := ws.ReadManifest(info.Root)
	if err != nil {
		return nil, err
	}
	keepFiles := make(map[string]bool, len(manifest.Files))
	for _, e := range manifest.Files {
		keepFiles[relKey(e.Rel)] = true
	}
	var keep []string
	for _, k := range info.Keep {
		k = strings.Trim(strings.ToLower(filepath.ToSlash(k)), "/")
		if k != "" {
			keep = append(keep, k)
		}
	}
	var out []TidyFile
	err = filepath.WalkDir(lib, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == lib {
				if os.IsNotExist(err) {
					return filepath.SkipAll
				}
				return err
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if p == lib {
			return nil
		}
		if skipEntry(p, d) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(lib, p)
		if err != nil {
			return nil
		}
		key := strings.ToLower(filepath.ToSlash(rel))
		if inKeep(keep, key) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() || keepFiles[key] {
			return nil
		}
		st, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, TidyFile{Path: p, Size: st.Size()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func inKeep(keep []string, key string) bool {
	for _, k := range keep {
		if key == k || strings.HasPrefix(key, k+"/") {
			return true
		}
	}
	return false
}

// tidy is the tidy job (Demo kind only).
func (m *Module) tidy(ctx context.Context, job *core.JobContext) error {
	info := m.cfg.Boot.Info
	if info.Kind != ws.KindDemo {
		return core.ValidationError("Tidy up is only for Demo workspaces", nil)
	}
	if m.cfg.Trash == nil || !m.cfg.Trash.Available() {
		return core.Errorf(core.CodeConflict, "Moving files to the Trash isn't available here")
	}
	if m.cfg.ActiveJobs != nil {
		if n := m.cfg.ActiveJobs(ctx, job.ID); n > 0 {
			return core.Errorf(core.CodeConflict, "Wait for %d %s to finish", n, plural(n, "job", "jobs"))
		}
	}
	job.SetTitle("Tidying up the workspace")
	job.Progress(core.IndeterminateProgress, "Looking for files to move…")
	files, err := PlanTidy(ctx, info)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return core.Errorf(core.CodeInternal, "Couldn't look through the library").WithCause(err)
	}
	lib := ws.LibraryDirOf(info.Root)
	res := Result{Action: ActionTidy, Skipped: []string{}, Unstripped: []string{}, Failed: []string{}}
	var trashed []string
	const batch = 50
	for start := 0; start < len(files); start += batch {
		if ctx.Err() != nil {
			return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(ctx.Err())
		}
		end := min(start+batch, len(files))
		var paths []string
		for _, f := range files[start:end] {
			// Re-check at the last moment: inside the library, still a regular file, never a link.
			if checkInside(f.Path, lib) != nil {
				res.Failed = append(res.Failed, f.Path)
				continue
			}
			if st, err := os.Lstat(f.Path); err != nil || !st.Mode().IsRegular() {
				continue
			}
			paths = append(paths, f.Path)
		}
		errs := m.cfg.Trash.Trash(paths)
		for i, p := range paths {
			if i < len(errs) && errs[i] != nil {
				res.Failed = append(res.Failed, p)
				job.Logf("couldn't move %s: %v", filepath.Base(p), errs[i])
				continue
			}
			trashed = append(trashed, p)
		}
		job.Progress(float64(end)/float64(len(files)), fmt.Sprintf("Moved %d of %d", end, len(files)))
	}
	res.Trashed = len(trashed)
	if m.cfg.Forget != nil && len(trashed) > 0 {
		m.cfg.Forget(trashed)
	}
	if m.cfg.ClearHistory != nil {
		n, err := m.cfg.ClearHistory(ctx)
		if err != nil {
			job.Logf("couldn't clear the job history: %v", err)
		}
		res.Cleared = n
	}
	_ = job.SetResult(res)
	msg := fmt.Sprintf("Moved %d %s to the Trash", res.Trashed, plural(res.Trashed, "file", "files"))
	if len(res.Failed) > 0 {
		msg += fmt.Sprintf(" · %d couldn't be moved", len(res.Failed))
	}
	job.Progress(1, msg)
	return nil
}
