package pipeline

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"toolbox/core"
)

// watchSig is what a poll saw of a file.
type watchSig struct{ size, mtime int64 }

// watchTrack remembers the previous poll of one pipeline's folder.
type watchTrack struct{ prev map[string]watchSig }

type watchFile struct {
	path string
	sig  watchSig
}

// startWatch polls the watch folders on one ticker (SPEC.md §8.9).
func (r *Runner) startWatch(ctx context.Context) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		t := time.NewTicker(r.watchEvery)
		defer t.Stop()
		for {
			select {
			case <-r.quit:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				r.pollWatch()
			}
		}
	}()
}

// pollWatch polls every watching pipeline once.
func (r *Runner) pollWatch() {
	r.watchMu.Lock()
	defer r.watchMu.Unlock()
	for _, p := range r.snapshotPipes() {
		if p.Watch.Enabled {
			r.pollPipeline(p)
		}
	}
}

var tempSuffixes = []string{".part", ".crdownload", ".tmp", ".download"}

// ignoredWatchFile reports hidden and temporary names.
func ignoredWatchFile(name string) bool {
	if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "~$") {
		return true
	}
	l := strings.ToLower(name)
	for _, s := range tempSuffixes {
		if strings.HasSuffix(l, s) {
			return true
		}
	}
	return false
}

// listWatchFiles returns the regular, visible, non-temporary files at the
// top level of folder.
func listWatchFiles(folder string) ([]watchFile, error) {
	entries, err := os.ReadDir(folder)
	if err != nil {
		return nil, err
	}
	var out []watchFile
	for _, e := range entries {
		if ignoredWatchFile(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		path := filepath.Join(folder, e.Name())
		if hiddenAttr(path) {
			continue
		}
		out = append(out, watchFile{path: path, sig: watchSig{info.Size(), info.ModTime().UnixMilli()}})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out, nil
}

// watchState reports whether a pipeline's watch folder is being polled.
func (r *Runner) watchState(p core.Pipeline, check core.PipelineCheck) core.WatchState {
	if !p.Watch.Enabled {
		return core.WatchState{}
	}
	if info, err := os.Stat(p.Watch.Folder); err != nil || !info.IsDir() {
		return core.WatchState{Message: "Folder not found"}
	}
	if !check.Ready {
		for i, sc := range check.Steps {
			if len(sc.Problems) > 0 {
				return core.WatchState{Message: fmt.Sprintf("Fix the problems in step %d", i+1)}
			}
		}
		return core.WatchState{Message: "Fix the problems first"}
	}
	r.pmu.RLock()
	msg := r.watchMsg[p.ID]
	r.pmu.RUnlock()
	return core.WatchState{Active: true, Message: msg}
}

func (r *Runner) setWatchMsg(id, msg string) {
	r.pmu.Lock()
	if msg == "" {
		delete(r.watchMsg, id)
	} else {
		r.watchMsg[id] = msg
	}
	r.pmu.Unlock()
}

// pollPipeline is one poll of one folder. Callers hold watchMu.
func (r *Runner) pollPipeline(p core.Pipeline) {
	check := r.Describe(p)
	st := r.watchState(p, check)
	if !st.Active {
		delete(r.watch, p.ID)
		return
	}
	files, err := listWatchFiles(p.Watch.Folder)
	if err != nil {
		delete(r.watch, p.ID)
		return
	}
	tr := r.watch[p.ID]
	if tr == nil {
		tr = &watchTrack{prev: map[string]watchSig{}}
		r.watch[p.ID] = tr
	}
	var seen map[string]core.SeenFile
	if r.cfg.Store != nil {
		seen, _ = r.cfg.Store.SeenFiles(context.Background(), p.ID)
	}
	now := r.nowMs()
	cur := map[string]watchSig{}
	var ready []watchFile
	for _, f := range files {
		if !check.Accepts.Any && !hasExt(check.Accepts.Extensions, f.path) {
			continue
		}
		cur[f.path] = f.sig
		prev, ok := tr.prev[f.path]
		if !ok || prev != f.sig || now-f.sig.mtime < r.stableAge.Milliseconds() {
			continue
		}
		if s, ok := seen[f.path]; ok && s.Size == f.sig.size && s.MTime == f.sig.mtime {
			continue
		}
		ready = append(ready, f)
	}
	tr.prev = cur
	if len(ready) == 0 {
		r.setWatchMsg(p.ID, "")
		return
	}
	if len(ready) > MaxItems {
		ready = ready[:MaxItems]
	}
	inputs := make([]string, len(ready))
	seenNow := make([]core.SeenFile, len(ready))
	for i, f := range ready {
		inputs[i] = f.path
		seenNow[i] = core.SeenFile{Path: f.path, Size: f.sig.size, MTime: f.sig.mtime}
	}
	if _, err := r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: inputs}, "watch"); err != nil {
		r.setWatchMsg(p.ID, core.AsAppError(err).Message)
		return
	}
	r.setWatchMsg(p.ID, "")
	if r.cfg.Store != nil {
		logErr("mark watch files seen", r.cfg.Store.MarkSeen(context.Background(), p.ID, seenNow))
	}
}

func hasExt(exts []string, path string) bool {
	e := strings.ToLower(filepath.Ext(path))
	for _, x := range exts {
		if x == e {
			return true
		}
	}
	return false
}

// baseline records the files already in a newly watched folder as seen, so
// they don't start a run.
func (r *Runner) baseline(p core.Pipeline) {
	if r.cfg.Store == nil || !filepath.IsAbs(p.Watch.Folder) {
		return
	}
	files, err := listWatchFiles(p.Watch.Folder)
	if err != nil {
		return
	}
	seen := make([]core.SeenFile, len(files))
	for i, f := range files {
		seen[i] = core.SeenFile{Path: f.path, Size: f.sig.size, MTime: f.sig.mtime}
	}
	logErr("baseline watch folder", r.cfg.Store.MarkSeen(context.Background(), p.ID, seen))
}

// pruneSeen forgets seen rows of files that no longer exist (at Start).
func (r *Runner) pruneSeen() {
	if r.cfg.Store == nil {
		return
	}
	for _, p := range r.snapshotPipes() {
		seen, err := r.cfg.Store.SeenFiles(context.Background(), p.ID)
		if err != nil {
			continue
		}
		var gone []string
		for path := range seen {
			if _, err := os.Stat(path); err != nil {
				gone = append(gone, path)
			}
		}
		logErr("prune seen files", r.cfg.Store.ForgetSeen(context.Background(), p.ID, gone))
	}
}
