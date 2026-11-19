package mediaindex

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"toolbox/core"
	"toolbox/core/doctext"
	"toolbox/core/par"
)

// Scanning the library and project thumbnails, and reconciling what's on
// disk with the index (SPEC.md §3.2). A reconcile is a stat walk only.

const (
	// MaxMediaBytes is the largest video or audio file indexed.
	MaxMediaBytes = 4 << 30
	// MaxOtherBytes is the largest picture, PDF or document indexed.
	MaxOtherBytes = 200 << 20
	// statWorkers bounds the fan-out of stat calls (subprocess-light work).
	statWorkers = 6
)

var (
	imageExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true,
		".bmp": true, ".tif": true, ".tiff": true, ".heic": true, ".heif": true}
	videoExts = map[string]bool{".mp4": true, ".mov": true, ".m4v": true, ".mkv": true, ".webm": true, ".avi": true}
	audioExts = map[string]bool{".mp3": true, ".m4a": true, ".wav": true, ".flac": true, ".ogg": true, ".opus": true, ".aac": true}
)

// KindOf classifies a file by extension into a core.MediaKind*; ok is false
// for files the index doesn't cover.
func KindOf(path string) (kind string, ok bool) {
	ext := strings.ToLower(filepath.Ext(path))
	switch {
	case imageExts[ext]:
		return core.MediaKindImage, true
	case videoExts[ext]:
		return core.MediaKindVideo, true
	case audioExts[ext]:
		return core.MediaKindAudio, true
	case ext == ".pdf":
		return core.MediaKindPDF, true
	case doctext.Supported(path):
		return core.MediaKindDoc, true
	}
	return "", false
}

// hiddenName reports whether a file or folder name is hidden or system
// clutter.
func hiddenName(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	switch strings.ToLower(name) {
	case "thumbs.db", "desktop.ini", "ehthumbs.db":
		return true
	}
	return false
}

// pathKey normalises a path for comparisons (case-insensitive on Windows and macOS).
func pathKey(p string) string {
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p = strings.ToLower(p)
	}
	return p
}

// scanRules decide what the walk may enter and read.
type scanRules struct {
	root    string
	skip    []string // library-relative folders ("/" separated, cleaned)
	exclude []string // absolute folders that are never indexed (the support dir)
}

func newScanRules(root string, skip, exclude []string) scanRules {
	r := scanRules{root: filepath.Clean(root)}
	for _, s := range skip {
		s = strings.Trim(strings.ReplaceAll(strings.TrimSpace(s), `\`, "/"), "/")
		if s != "" {
			r.skip = append(r.skip, s)
		}
	}
	for _, e := range exclude {
		// A folder that contains the library would exclude everything.
		if e != "" && !core.IsWithin(pathKey(r.root), pathKey(e)) {
			r.exclude = append(r.exclude, filepath.Clean(e))
		}
	}
	return r
}

// rel is the library-relative path of abs with "/" separators.
func (r scanRules) rel(abs string) (string, bool) {
	rel, err := filepath.Rel(r.root, filepath.Clean(abs))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func sameKey(a, b string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// skipDir reports whether a folder (library-relative, "/" separated; "" is
// the root) is never entered: a skip-list folder or below, or an excluded
// absolute folder.
func (r scanRules) skipDir(rel string) bool {
	if rel == "" {
		return false
	}
	for _, s := range r.skip {
		if sameKey(rel, s) || (len(rel) > len(s) && sameKey(rel[:len(s)], s) && rel[len(s)] == '/') {
			return true
		}
	}
	abs := filepath.Join(r.root, filepath.FromSlash(rel))
	for _, e := range r.exclude {
		if core.IsWithin(pathKey(abs), pathKey(e)) {
			return true
		}
	}
	return false
}

// skipPath reports whether a file path (absolute) is out of scope because of
// its name, a hidden or skipped folder above it, or an excluded folder.
func (r scanRules) skipPath(abs string) bool {
	rel, ok := r.rel(abs)
	if !ok || rel == "." {
		return true
	}
	parts := strings.Split(rel, "/")
	for i, p := range parts {
		if hiddenName(p) {
			return true
		}
		if i < len(parts)-1 && r.skipDir(strings.Join(parts[:i+1], "/")) {
			return true
		}
	}
	for _, e := range r.exclude {
		if core.IsWithin(pathKey(abs), pathKey(e)) {
			return true
		}
	}
	return false
}

// candidate is a file the walk found, before its stat.
type candidate struct {
	path string
	kind string
}

// walk lists the files of the library the index covers: no hidden or system
// entries, no symlinks or junctions (never followed), no skipped folders.
func (r scanRules) walk(ctx context.Context) ([]candidate, error) {
	if fi, err := os.Stat(r.root); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("library folder %q is not available", r.root)
	}
	var out []candidate
	stack := []string{""}
	for len(stack) > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		rel := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		dir := filepath.Join(r.root, filepath.FromSlash(rel))
		entries, err := os.ReadDir(dir)
		if err != nil {
			if rel == "" {
				return nil, fmt.Errorf("read library folder: %w", err)
			}
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if hiddenName(name) {
				continue
			}
			t := e.Type()
			if t&(fs.ModeSymlink|fs.ModeIrregular) != 0 { // links and Windows junctions
				continue
			}
			child := name
			if rel != "" {
				child = rel + "/" + name
			}
			abs := filepath.Join(dir, name)
			switch {
			case t.IsDir():
				if r.skipDir(child) || hasHiddenAttr(abs) {
					continue
				}
				stack = append(stack, child)
			case t.IsRegular():
				if kind, ok := KindOf(name); ok {
					out = append(out, candidate{abs, kind})
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out, nil
}

// buildItem makes the row a file should have: its stage states depend on the
// kind, the size limits and the settings.
func buildItem(path, kind, source, ref string, size, modMs int64, speechOn bool) Item {
	it := Item{Path: path, Source: source, SourceRef: ref, Kind: kind, Size: size, ModMs: modMs, State: StatePending, SpeechState: SpeechNone}
	limit, label := int64(MaxOtherBytes), "200 MB"
	if kind == core.MediaKindVideo || kind == core.MediaKindAudio {
		limit, label = MaxMediaBytes, "4 GB"
	}
	if size > limit {
		it.State, it.Reason = StateSkipped, "Larger than "+label
		return it
	}
	if kind == core.MediaKindAudio {
		it.State = StateDone // nothing to see; only speech
	}
	if speechOn && (kind == core.MediaKindAudio || kind == core.MediaKindVideo) {
		it.SpeechState = SpeechPending
	}
	return it
}

// statCandidates stats files with bounded fan-out, dropping the unreadable,
// the not-regular and the Windows hidden/system ones. Results keep order.
func statCandidates(ctx context.Context, cs []candidate, source string, speechOn bool) ([]Item, error) {
	res, err := par.Map(ctx, len(cs), statWorkers, func(_ context.Context, i int) (*Item, error) {
		c := cs[i]
		fi, err := os.Lstat(c.path)
		if err != nil || !fi.Mode().IsRegular() || hasHiddenAttr(c.path) {
			return nil, nil
		}
		it := buildItem(c.path, c.kind, source, "", fi.Size(), fi.ModTime().UnixMilli(), speechOn)
		return &it, nil
	})
	if err != nil {
		return nil, err
	}
	out := make([]Item, 0, len(res))
	for _, it := range res {
		if it != nil {
			out = append(out, *it)
		}
	}
	return out, nil
}

// diffItems compares the rows of one source with what's on disk. Changed
// rows keep their path but are redone; Remove lists rows with no file.
func diffItems(existing, desired []Item) (add, changed []Item, remove []string) {
	have := make(map[string]Item, len(existing))
	for _, e := range existing {
		have[pathKey(e.Path)] = e
	}
	want := make(map[string]bool, len(desired))
	for _, d := range desired {
		k := pathKey(d.Path)
		want[k] = true
		e, ok := have[k]
		switch {
		case !ok:
			add = append(add, d)
		case e.Size != d.Size || e.ModMs != d.ModMs:
			d.Path = e.Path
			changed = append(changed, d)
		}
	}
	for _, e := range existing {
		if !want[pathKey(e.Path)] {
			remove = append(remove, e.Path)
		}
	}
	return add, changed, remove
}

// excludedDirs lists the folders the walk never enters: the ones set through
// SetExcluded plus the support dir, derived from project thumbnails
// (<support>/projects/<id>/thumb.jpg) when it lies under the library.
func (ix *Index) excludedDirs(projects []Project) []string {
	ix.mu.Lock()
	ex := append([]string(nil), ix.excluded...)
	ix.mu.Unlock()
	for _, p := range projects {
		if p.Thumb != "" {
			ex = append(ex, filepath.Dir(filepath.Dir(filepath.Dir(p.Thumb))))
		}
	}
	return ex
}

// clean normalises a path from outside the index: cleaned and, inside the
// library, written with the library folder's own spelling, so a difference in
// case (Windows, macOS) never makes a second row for one file.
func (ix *Index) clean(p string) string {
	p = filepath.Clean(p)
	if ix.cfg.LibraryDir == nil {
		return p
	}
	lib := filepath.Clean(ix.cfg.LibraryDir())
	if lib == "." {
		return p
	}
	rel, err := filepath.Rel(lib, p)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return p
	}
	return filepath.Join(lib, rel)
}

// SetExcluded adds folders that are never indexed (the app's support dir).
func (ix *Index) SetExcluded(dirs ...string) {
	ix.mu.Lock()
	ix.excluded = append(ix.excluded[:0], dirs...)
	ix.mu.Unlock()
}

// projectItems lists the project thumbnails that exist.
func (ix *Index) projectItems(ctx context.Context, speechOn bool) ([]Project, []Item, bool) {
	if ix.cfg.Projects == nil {
		return nil, nil, false
	}
	ps, err := ix.cfg.Projects(ctx)
	if err != nil {
		return nil, nil, false
	}
	var items []Item
	for _, p := range ps {
		if p.Thumb == "" {
			continue
		}
		fi, err := os.Lstat(p.Thumb)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		items = append(items, buildItem(filepath.Clean(p.Thumb), core.MediaKindImage, core.SearchSourceProject, p.ID,
			fi.Size(), fi.ModTime().UnixMilli(), speechOn))
	}
	return ps, items, true
}

// reconcile brings the index in step with the library and the projects:
// new files get rows, changed ones are redone, gone ones deleted. It reports
// whether anything changed.
func (ix *Index) reconcile(ctx context.Context) (bool, error) {
	s := ix.Settings()
	if !s.Enabled {
		return false, nil
	}
	lib := ""
	if ix.cfg.LibraryDir != nil {
		lib = ix.cfg.LibraryDir()
	}
	projects, projItems, projOK := ix.projectItems(ctx, s.Speech)
	var libItems []Item
	libOK := false
	if lib != "" {
		rules := newScanRules(lib, s.Skip, ix.excludedDirs(projects))
		cs, err := rules.walk(ctx)
		switch {
		case err == nil:
			libItems, err = statCandidates(ctx, cs, core.SearchSourceLibrary, s.Speech)
			if err != nil {
				return false, err
			}
			libOK = true
		case ctx.Err() != nil:
			return false, ctx.Err()
		}
		// A missing library folder (a drive that isn't there) changes nothing.
	}
	all, err := ix.cfg.Store.AllItems(ctx)
	if err != nil {
		return false, err
	}
	var libRows, projRows []Item
	for _, it := range all {
		if it.Source == core.SearchSourceProject {
			projRows = append(projRows, it)
		} else {
			libRows = append(libRows, it)
		}
	}
	var delta ScanDelta
	if libOK {
		a, c, r := diffItems(libRows, libItems)
		delta.Add, delta.Changed, delta.Remove = append(delta.Add, a...), append(delta.Changed, c...), append(delta.Remove, r...)
	}
	if projOK {
		a, c, r := diffItems(projRows, projItems)
		delta.Add, delta.Changed, delta.Remove = append(delta.Add, a...), append(delta.Changed, c...), append(delta.Remove, r...)
	}
	changed := len(delta.Add)+len(delta.Changed)+len(delta.Remove) > 0
	if changed {
		if err := ix.cfg.Store.ApplyScan(ctx, delta); err != nil {
			return false, err
		}
		if len(delta.Changed)+len(delta.Remove) > 0 {
			ix.vec.drop()
		}
	}
	if m := ix.Model(); m.ID != "" {
		n, err := ix.cfg.Store.MarkModelStale(ctx, m.ID)
		if err != nil {
			return changed, err
		}
		if n > 0 {
			ix.vec.drop()
			changed = true
		}
	}
	return changed, nil
}

// syncPaths brings single files in step (library:added, a tool wrote a file).
func (ix *Index) syncPaths(ctx context.Context, paths []string) error {
	s := ix.Settings()
	lib := ""
	if ix.cfg.LibraryDir != nil {
		lib = ix.cfg.LibraryDir()
	}
	if !s.Enabled || lib == "" {
		return nil
	}
	rules := newScanRules(lib, s.Skip, ix.excludedDirs(nil))
	var cs []candidate
	for _, p := range paths {
		p = ix.clean(p)
		if !filepath.IsAbs(p) || rules.skipPath(p) {
			continue
		}
		if kind, ok := KindOf(p); ok {
			cs = append(cs, candidate{p, kind})
		}
	}
	if len(cs) == 0 {
		return nil
	}
	items, err := statCandidates(ctx, cs, core.SearchSourceLibrary, s.Speech)
	if err != nil {
		return err
	}
	var delta ScanDelta
	for _, it := range items {
		row, ok, err := ix.cfg.Store.GetItem(ctx, it.Path)
		if err != nil {
			return err
		}
		switch {
		case !ok:
			delta.Add = append(delta.Add, it)
		case row.Size != it.Size || row.ModMs != it.ModMs:
			delta.Changed = append(delta.Changed, it)
		}
	}
	if len(delta.Add)+len(delta.Changed) == 0 {
		return nil
	}
	if err := ix.cfg.Store.ApplyScan(ctx, delta); err != nil {
		return err
	}
	if len(delta.Changed) > 0 {
		ix.vec.drop()
	}
	return nil
}

// syncProjects brings the project thumbnails in step (a project was saved).
func (ix *Index) syncProjects(ctx context.Context) error {
	s := ix.Settings()
	if !s.Enabled {
		return nil
	}
	_, items, ok := ix.projectItems(ctx, s.Speech)
	if !ok {
		return nil
	}
	all, err := ix.cfg.Store.AllItems(ctx)
	if err != nil {
		return err
	}
	var rows []Item
	for _, it := range all {
		if it.Source == core.SearchSourceProject {
			rows = append(rows, it)
		}
	}
	a, c, r := diffItems(rows, items)
	if len(a)+len(c)+len(r) == 0 {
		return nil
	}
	if err := ix.cfg.Store.ApplyScan(ctx, ScanDelta{Add: a, Changed: c, Remove: r}); err != nil {
		return err
	}
	if len(c)+len(r) > 0 {
		ix.vec.drop()
	}
	return nil
}
