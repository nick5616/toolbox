package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/par"
	"toolbox/core/proc"
	ws "toolbox/core/workspace"
)

// copyWorkers is how many files are copied at once (SPEC §A4).
const copyWorkers = 6

func relKey(rel string) string { return strings.ToLower(rel) }

// copyBaseline is the seed and restore job. Seed copies every baseline file
// and writes a fresh manifest; restore copies only the files that are missing
// or whose size or hash differ from the manifest (or that the manifest doesn't
// list) and merges the manifest. Neither deletes anything.
func (m *Module) copyBaseline(ctx context.Context, job *core.JobContext, action Action) error {
	info := m.cfg.Boot.Info
	if info.Baseline == "" {
		return core.ValidationError("This workspace has no starting folder", nil)
	}
	if st, err := os.Stat(info.Baseline); err != nil || !st.IsDir() {
		return core.Errorf(core.CodeNotFound, "The starting folder isn't there").
			WithHint("Plug in the drive or restore the folder, then try again")
	}
	lib := ws.LibraryDirOf(info.Root)
	if err := os.MkdirAll(lib, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the library folder").WithCause(err)
	}
	if action == ActionSeed {
		job.SetTitle("Copying the starting files")
	} else {
		job.SetTitle("Restoring the starting files")
	}
	job.Progress(core.IndeterminateProgress, "Looking at the starting files…")
	plan, err := walkBaseline(ctx, info.Baseline, info.Exclude)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return core.Errorf(core.CodeInternal, "Couldn't read the starting folder").WithCause(err)
	}

	entries := map[string]ws.ManifestEntry{}
	need := plan
	if action == ActionRestore {
		old, _, err := ws.ReadManifest(info.Root)
		if err != nil {
			job.Logf("the baseline manifest couldn't be read, so every file is checked again: %v", err)
		}
		for _, e := range old.Files {
			entries[relKey(e.Rel)] = e
		}
		if need, err = m.changed(ctx, lib, plan, entries); err != nil {
			return err
		}
	}

	res := Result{Action: action, Skipped: []string{}, Unstripped: []string{}, Failed: []string{}}
	copied, err := m.copyAll(ctx, job, lib, need, &res)
	if err != nil {
		return err // cancelled or failed: no manifest, the next boot seeds again
	}
	if action == ActionSeed {
		entries = map[string]ws.ManifestEntry{}
	}
	for i, c := range copied {
		if c == nil {
			continue
		}
		entries[relKey(need[i].Rel)] = ws.ManifestEntry{Rel: need[i].Rel, SrcSha256: c.SrcSha256, Size: c.Size, Sha256: c.Sha256}
		res.Copied++
	}
	manifest := ws.Manifest{Files: make([]ws.ManifestEntry, 0, len(entries))}
	for _, e := range entries {
		manifest.Files = append(manifest.Files, e)
	}
	sort.Slice(manifest.Files, func(i, j int) bool { return manifest.Files[i].Rel < manifest.Files[j].Rel })
	if err := ws.WriteManifest(info.Root, manifest); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the baseline list").WithCause(err)
	}

	// Register the copies as library files, in order.
	for i, c := range copied {
		if c == nil {
			continue
		}
		dst := filepath.Join(lib, filepath.FromSlash(need[i].Rel))
		if err := m.register(job, dst); err != nil {
			job.Logf("not added to the Library: %s: %v", need[i].Rel, err)
		}
	}
	_ = job.SetResult(res)
	switch {
	case action == ActionRestore && res.Copied == 0 && len(res.Skipped) == 0:
		job.Progress(1, "Nothing to restore")
	case action == ActionRestore:
		job.Progress(1, fmt.Sprintf("Restored %d %s", res.Copied, plural(res.Copied, "file", "files")))
	default:
		job.Progress(1, fmt.Sprintf("Copied %d %s", res.Copied, plural(res.Copied, "file", "files")))
	}
	if len(res.Skipped) > 0 {
		job.Logf("WARNING: %d %s couldn't be copied (in use?): %s", len(res.Skipped), plural(len(res.Skipped), "file", "files"), strings.Join(res.Skipped, ", "))
	}
	if len(res.Unstripped) > 0 {
		job.Logf("WARNING: location data may remain in: %s", strings.Join(res.Unstripped, ", "))
	}
	return nil
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func (m *Module) register(job *core.JobContext, path string) error {
	if m.cfg.Register != nil {
		return m.cfg.Register(path)
	}
	_, err := job.Output(path)
	return err
}

// changed returns the plan files whose copy is missing, has a different size
// or hash than the manifest says, or isn't in the manifest.
func (m *Module) changed(ctx context.Context, lib string, plan []srcFile, entries map[string]ws.ManifestEntry) ([]srcFile, error) {
	flags := make([]bool, len(plan))
	err := par.ForEach(ctx, len(plan), copyWorkers, func(ctx context.Context, i int) error {
		f := plan[i]
		e, ok := entries[relKey(f.Rel)]
		if !ok {
			flags[i] = true
			return nil
		}
		dst := filepath.Join(lib, filepath.FromSlash(f.Rel))
		st, err := os.Lstat(dst)
		if err != nil || !st.Mode().IsRegular() || st.Size() != e.Size {
			flags[i] = true
			return nil
		}
		sum, _, err := hashFile(ctx, dst)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil || sum != e.Sha256 {
			flags[i] = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	var out []srcFile
	for i, f := range plan {
		if flags[i] {
			out = append(out, f)
		}
	}
	return out, nil
}

// copyAll copies files into the library with copyWorkers at a time. The
// returned slice is by index: nil = not copied (named in res.Skipped).
func (m *Module) copyAll(ctx context.Context, job *core.JobContext, lib string, files []srcFile, res *Result) ([]*copyResult, error) {
	info := m.cfg.Boot.Info
	out := make([]*copyResult, len(files))
	if len(files) == 0 {
		return out, nil
	}
	exe := ""
	if info.StripLocation {
		var err error
		if exe, err = job.Tool(deps.ExifTool); err != nil {
			exe = ""
			job.Logf("WARNING: ExifTool isn't installed, so photo and video copies keep their location data")
		}
	}
	stripFn := m.cfg.Strip
	if stripFn == nil {
		stripFn = func(ctx context.Context, exe, file string) error {
			_, err := proc.Run(ctx, proc.Spec{Path: exe, Args: exifStripArgs(file), OnStderr: func(l string) { job.Log(core.StreamStderr, l) }})
			return err
		}
	}
	var (
		done     atomic.Int64
		skipped  = make([]string, len(files))
		unstrip  = make([]string, len(files))
		total    = len(files)
		progress = func() {
			n := int(done.Add(1))
			job.Progress(float64(n)/float64(total), fmt.Sprintf("Copying the starting files… %d of %d", n, total))
		}
	)
	job.Progress(0, fmt.Sprintf("Copying the starting files… 0 of %d", total))
	err := par.ForEach(ctx, total, copyWorkers, func(ctx context.Context, i int) error {
		f := files[i]
		defer progress()
		dst := filepath.Join(lib, filepath.FromSlash(f.Rel))
		if err := checkInside(dst, lib); err != nil {
			skipped[i] = f.Rel
			job.Logf("skipped %s: %v", f.Rel, err)
			return nil
		}
		var strip func(string) error
		if info.StripLocation && isMedia(f.Rel) {
			if exe == "" {
				unstrip[i] = f.Rel
			} else {
				strip = func(tmp string) error { return stripFn(ctx, exe, tmp) }
			}
		}
		c, err := copyFile(ctx, f, dst, strip)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			skipped[i] = f.Rel
			unstrip[i] = ""
			if isStripError(err) {
				job.Logf("skipped %s: %v", f.Rel, err)
			} else {
				job.Logf("skipped %s (in use or unreadable): %v", f.Rel, err)
			}
			return nil
		}
		out[i] = &c
		return nil
	})
	if err != nil {
		if ctx.Err() != nil || errors.Is(err, context.Canceled) {
			return nil, core.Errorf(core.CodeCancelled, "Cancelled").WithCause(err)
		}
		return nil, err
	}
	for i := range files {
		if skipped[i] != "" {
			res.Skipped = append(res.Skipped, skipped[i])
		}
		if unstrip[i] != "" {
			res.Unstripped = append(res.Unstripped, unstrip[i])
		}
	}
	return out, nil
}
