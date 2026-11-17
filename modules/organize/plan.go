package organize

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"toolbox/core"
	"toolbox/core/par"
)

// entry is one file in a plan.
type entry struct {
	Src     string
	Size    int64
	ModTime time.Time
	Taken   time.Time // the date used for folders and for "oldest": EXIF, else modified time
	HasExif bool
	Camera  string
	Type    string
	Ext     string // lowercase, no dot
	W, H    int
	Hash    string // SHA-256 (hex) when computed
	Photo   photoHash
	HasHash bool

	DupOf   int  // index of the entry this one duplicates, -1 = none
	Similar bool // the duplicate was found by look-alike, not by content
	Group   string
	Dest    string // path relative to the run folder, forward slashes; "" = not copied
}

func (e *entry) pixels() int64 { return int64(e.W) * int64(e.H) }

// better orders duplicates: largest resolution, then oldest, then biggest file, then path.
func better(a, b *entry) bool {
	if a.pixels() != b.pixels() {
		return a.pixels() > b.pixels()
	}
	if !a.Taken.Equal(b.Taken) {
		return a.Taken.Before(b.Taken)
	}
	if a.Size != b.Size {
		return a.Size > b.Size
	}
	return pathKey(a.Src) < pathKey(b.Src)
}

// plan is the result of looking at the files: where each goes and what's a duplicate.
type plan struct {
	Opts    Options
	Entries []*entry // sorted by source path
}

// planner builds plans. The functions are replaceable in tests.
type planner struct {
	readMeta  readMetaFunc // nil = modified times only
	hashPhoto func(path string) (photoHash, error)
	photoSize func(path string) (w, h int)
	progress  func(pct float64, msg string)
}

func newPlanner(readMeta readMetaFunc, progress func(float64, string)) *planner {
	return &planner{readMeta: readMeta, hashPhoto: fileHash, photoSize: photoPixels, progress: progress}
}

// report maps stage progress (0..1) into [from, to] of the whole job.
func (p *planner) report(from, to, frac float64, msg string) {
	if p.progress != nil {
		p.progress(from+(to-from)*min(max(frac, 0), 1), msg)
	}
}

// Stage boundaries of the whole job (planning ends at planEnd; copying follows).
const (
	scanEnd  = 0.04
	metaEnd  = 0.20
	hashEnd  = 0.45
	likeEnd  = 0.60
	planEnd  = 0.60
	copyFrom = 0.60
)

// build looks at every file and decides the plan.
func (p *planner) build(ctx context.Context, inputs []string, opts Options) (*plan, error) {
	p.report(0, scanEnd, 0, "Finding files")
	files, err := expandInputs(ctx, inputs)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, core.ValidationError("There are no files to organize", map[string]string{"inputs": "No files found"}).
			WithHint("Folders are searched inside, ignoring hidden and system files.")
	}
	pl := &plan{Opts: opts}
	for _, f := range files {
		st, err := os.Stat(f)
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(f))
		pl.Entries = append(pl.Entries, &entry{
			Src: f, Size: st.Size(), ModTime: st.ModTime(), Taken: st.ModTime().Local(),
			Type: typeOf(f), Ext: strings.TrimPrefix(ext, "."), DupOf: -1,
		})
	}
	if len(pl.Entries) == 0 {
		return nil, core.ValidationError("There are no files to organize", map[string]string{"inputs": "No files found"})
	}
	p.report(0, scanEnd, 1, fmt.Sprintf("Found %d files", len(pl.Entries)))

	if err := p.applyMeta(ctx, pl); err != nil {
		return nil, err
	}
	if opts.Duplicates == DupExact || opts.Duplicates == DupSimilar {
		if err := p.findExact(ctx, pl); err != nil {
			return nil, err
		}
	}
	if opts.Duplicates == DupSimilar {
		if err := p.findSimilar(ctx, pl); err != nil {
			return nil, err
		}
	}
	if err := assignDestinations(pl); err != nil {
		return nil, err
	}
	return pl, nil
}

// applyMeta fills dates and cameras from ExifTool for photos and videos.
func (p *planner) applyMeta(ctx context.Context, pl *plan) error {
	if p.readMeta == nil {
		return nil
	}
	var paths []string
	for _, e := range pl.Entries {
		if e.Type == TypePhotos || e.Type == TypeVideos {
			paths = append(paths, e.Src)
		}
	}
	if len(paths) == 0 {
		return nil
	}
	got, err := p.readMeta(ctx, paths, func(done, total int) {
		p.report(scanEnd, metaEnd, float64(done)/float64(total), fmt.Sprintf("Reading dates · %d of %d", done, total))
	})
	if err != nil {
		return err
	}
	for _, e := range pl.Entries {
		m, ok := got[pathKey(e.Src)]
		if !ok {
			continue
		}
		if !m.Taken.IsZero() {
			e.Taken, e.HasExif = m.Taken, true
		}
		e.Camera = m.Camera
	}
	return nil
}

// sha256File hashes a file, checking ctx between chunks.
func sha256File(ctx context.Context, path string, onBytes func(n int64)) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, rerr := f.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
			if onBytes != nil {
				onBytes(int64(n))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", fmt.Errorf("read %s: %w", path, rerr)
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// findExact marks files with the same size and SHA-256 as duplicates of the best one.
func (p *planner) findExact(ctx context.Context, pl *plan) error {
	bySize := map[int64][]int{}
	for i, e := range pl.Entries {
		if e.Size > 0 {
			bySize[e.Size] = append(bySize[e.Size], i)
		}
	}
	var total int64
	for _, idx := range bySize {
		if len(idx) > 1 {
			for _, i := range idx {
				total += pl.Entries[i].Size
			}
		}
	}
	// Hash two files at a time (SSD-friendly without thrashing a spinning
	// disk); results are kept by position so grouping stays deterministic.
	sizes := make([]int64, 0, len(bySize))
	for s := range bySize {
		sizes = append(sizes, s)
	}
	sort.Slice(sizes, func(i, j int) bool { return sizes[i] < sizes[j] })
	var order []int
	for _, s := range sizes {
		if idx := bySize[s]; len(idx) >= 2 {
			order = append(order, idx...)
		}
	}
	sums := make([]string, len(order))
	var (
		done    atomic.Int64
		mu      sync.Mutex
		checked int
	)
	if err := par.ForEach(ctx, len(order), 2, func(ctx context.Context, k int) error {
		sum, err := sha256File(ctx, pl.Entries[order[k]].Src, func(n int64) { done.Add(n) })
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return nil // unreadable: never a duplicate
		}
		sums[k] = sum
		mu.Lock()
		checked++
		p.report(metaEnd, hashEnd, float64(done.Load())/float64(max(total, 1)), fmt.Sprintf("Comparing files \u00b7 %d checked", checked))
		mu.Unlock()
		return nil
	}); err != nil {
		return err
	}
	byHash := map[string][]int{}
	for k, i := range order {
		if sums[k] == "" {
			continue
		}
		pl.Entries[i].Hash = sums[k]
		byHash[sums[k]] = append(byHash[sums[k]], i)
	}
	for _, idx := range byHash {
		if len(idx) < 2 {
			continue
		}
		sort.Slice(idx, func(a, b int) bool { return better(pl.Entries[idx[a]], pl.Entries[idx[b]]) })
		for _, i := range idx[1:] {
			pl.Entries[i].DupOf = idx[0]
		}
	}
	return nil
}

// findSimilar clusters the remaining photos by perceptual hash. Photos are
// taken best first; each joins the first cluster whose best photo it matches,
// so a chain of slightly different photos doesn't merge into one.
func (p *planner) findSimilar(ctx context.Context, pl *plan) error {
	dist := maxDistance(pl.Opts.Similarity)
	var cand []int
	for i, e := range pl.Entries {
		if e.DupOf < 0 && e.Type == TypePhotos {
			cand = append(cand, i)
		}
	}
	// Decode and hash in parallel (the slow part), then keep everything that
	// depends on order sequential: results sit at their candidate's index.
	type look struct {
		h     photoHash
		w, ht int
		ok    bool
	}
	looks := make([]look, len(cand))
	var (
		mu   sync.Mutex
		done int
	)
	if err := par.ForEach(ctx, len(cand), par.CPUHalf(), func(ctx context.Context, n int) error {
		e := pl.Entries[cand[n]]
		h, err := p.hashPhoto(e.Src)
		if err == nil {
			w, ht := p.photoSize(e.Src)
			looks[n] = look{h: h, w: w, ht: ht, ok: true}
		}
		mu.Lock()
		done++
		p.report(hashEnd, likeEnd, float64(done)/float64(len(cand)), fmt.Sprintf("Comparing photos \u00b7 %d of %d", done, len(cand)))
		mu.Unlock()
		return nil
	}); err != nil {
		return err
	}
	hashed := cand[:0:0]
	for n, i := range cand {
		if !looks[n].ok {
			continue // can't be read as a picture: not a candidate
		}
		e := pl.Entries[i]
		e.Photo, e.HasHash = looks[n].h, true
		e.W, e.H = looks[n].w, looks[n].ht
		hashed = append(hashed, i)
	}
	sort.Slice(hashed, func(a, b int) bool { return better(pl.Entries[hashed[a]], pl.Entries[hashed[b]]) })
	var keepers []int
	for _, i := range hashed {
		e := pl.Entries[i]
		match := -1
		for _, k := range keepers {
			if pl.Entries[k].Photo.alike(e.Photo, dist) {
				match = k
				break
			}
		}
		if match < 0 {
			keepers = append(keepers, i)
			continue
		}
		e.DupOf, e.Similar = match, true
	}
	return nil
}

// assignDestinations chooses each file's folder and a unique name. Kept
// files are named first so duplicates never take their names.
func assignDestinations(pl *plan) error {
	pattern := patternFor(pl.Opts)
	if err := validatePattern(pattern); err != nil {
		return err
	}
	used := map[string]bool{strings.ToLower(ReportName): true}
	unique := func(dir, name string) string {
		ext := path.Ext(name)
		stem := strings.TrimSuffix(name, ext)
		for n := 1; ; n++ {
			cand := name
			if n > 1 {
				cand = fmt.Sprintf("%s (%d)%s", stem, n, ext)
			}
			rel := path.Join(dir, cand)
			if k := strings.ToLower(rel); !used[k] {
				used[k] = true
				return rel
			}
		}
	}
	for _, e := range pl.Entries {
		if e.DupOf >= 0 {
			continue
		}
		dir, err := expandPattern(pattern, patternVars{Taken: e.Taken, Type: e.Type, Camera: e.Camera, Ext: e.Ext})
		if err != nil {
			return err
		}
		e.Group = dir
		e.Dest = unique(dir, filepath.Base(e.Src))
	}
	for _, e := range pl.Entries {
		if e.DupOf < 0 {
			continue
		}
		e.Group = DuplicatesDir
		if pl.Opts.DupAction == ActionSkip {
			continue
		}
		e.Dest = unique(DuplicatesDir, filepath.Base(e.Src))
	}
	return nil
}

// keeper follows DupOf to the file that stays in its folder.
func (pl *plan) keeper(e *entry) *entry {
	for e.DupOf >= 0 {
		e = pl.Entries[e.DupOf]
	}
	return e
}
