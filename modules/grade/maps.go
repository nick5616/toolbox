package grade

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"slices"
	"time"

	xdraw "golang.org/x/image/draw"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// Region maps (SPEC §E5), cached in <cache>/grade/<fileKey>/:
//
//	pictures: depth.png (16-bit, near = white), subject.png (alpha), *-thumb.png
//	videos:   depth-export.h264 / depth-preview.h264 (+ .idx.json), subject-export.h264 / -preview.h264, *-thumb.png
//
// "subject" and "people" are the same map: the Background Remover model's alpha
// for a picture, Edit Studio's people matte for a video. <fileKey> is
// path + size + modification time, so an edited file gets fresh maps.

// Cache limits (pruned at start).
const (
	CacheMaxAgeDays = 30
	CacheMaxBytes   = 5 << 30
)

// Component IDs of the models a region needs (core/packs catalog).
const (
	depthComponent   = "depth-v2s"
	photoComponent   = "bg-default"
	peopleComponent  = "matte-people"
	depthStreamShort = 540  // depth is blurry by nature: made from the preview-tier stream
	matteStreamShort = 1080 // as Edit Studio's mattes
)

// Largest sizes of an export (SPEC §E6).
const (
	MaxStillLong = 8192
	MaxVideoLong = 3840
)

// mediaProbeFn is a seam for tests.
var mediaProbeFn = media.Probe

// gradeFPS are the frame rates the editor supports.
var gradeFPS = []int{24, 25, 30, 60}

// pickFPS maps a source frame rate to the nearest supported one (0 = 30).
func pickFPS(fps float64) int {
	if fps <= 0 {
		return 30
	}
	best, bd := 30, math.MaxFloat64
	for _, f := range gradeFPS {
		if d := math.Abs(fps - float64(f)); d < bd {
			best, bd = f, d
		}
	}
	return best
}

// fitSize is a source's size with its long side capped, both sides even (≥ 2).
func fitSize(w, h, maxLong int) (int, int) {
	if long := max(w, h); long > maxLong {
		s := float64(maxLong) / float64(long)
		w, h = int(math.Round(float64(w)*s)), int(math.Round(float64(h)*s))
	}
	even := func(v int) int { return max(2, v/2*2) }
	return even(w), even(h)
}

func (m *Module) cacheDirFor(path string) (string, error) {
	if m.cfg.CacheDir == "" {
		return "", core.Errorf(core.CodeInternal, "The maps folder isn't available")
	}
	key, err := viz.FileKey(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "This file doesn't exist any more").WithCause(err)
	}
	return filepath.Join(m.cfg.CacheDir, key), nil
}

func regular(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular() && fi.Size() > 0
}

// mapInfo describes one map of a file whose cache folder is dir.
func (m *Module) mapInfo(dir, name string, video bool) MapInfo {
	var info MapInfo
	thumb := filepath.Join(dir, name+"-thumb.png")
	if video {
		exp := filepath.Join(dir, name+"-export.h264")
		prev := filepath.Join(dir, name+"-preview.h264")
		if regular(exp) && regular(exp[:len(exp)-len(".h264")]+".idx.json") && regular(prev) && regular(prev[:len(prev)-len(".h264")]+".idx.json") {
			info.Ready, info.Stream = true, exp
		}
	} else if still := filepath.Join(dir, name+".png"); regular(still) {
		info.Ready, info.Still = true, still
	}
	if info.Ready && regular(thumb) {
		info.Preview = thumb
	}
	return info
}

// missingModel names the component to install for a map that isn't there, "" = available.
func (m *Module) missingModel(kind string, video bool) string {
	switch kind {
	case "depth":
		if !m.ModelPresent(DepthPreset) {
			return depthComponent
		}
	default:
		if m.cfg.Edit == nil {
			return peopleComponent
		}
		people, image := m.cfg.Edit.MatteModelsPresent()
		switch {
		case video && !people:
			return peopleComponent
		case !video && !image:
			return photoComponent
		}
	}
	return ""
}

// mapsOf is the state of a file's maps (without the jobs' "preparing").
func (m *Module) mapsOf(path string) (MapState, error) {
	st := MapState{Path: path, Preparing: []string{}}
	dir, err := m.cacheDirFor(path)
	if err != nil {
		return st, err
	}
	video := isVideo(path)
	st.Depth = m.mapInfo(dir, "depth", video)
	st.Subject = m.mapInfo(dir, "subject", video)
	st.People = st.Subject
	if !st.Depth.Ready {
		st.Depth.Missing = m.missingModel("depth", video)
	}
	if !st.Subject.Ready {
		st.Subject.Missing = m.missingModel("subject", video)
		st.People.Missing = st.Subject.Missing
	}
	return st, nil
}

// Maps says which region maps exist for a file and which are being made.
func (m *Module) Maps(path string) (MapState, error) {
	st, err := m.mapsOf(path)
	if err != nil {
		return st, err
	}
	if m.cfg.Jobs == nil {
		return st, nil
	}
	jobs, err := m.cfg.Jobs.List(context.Background(), core.JobFilter{
		ModuleID: ModuleID, Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 200,
	})
	if err != nil {
		return st, nil // the maps themselves are right; "preparing" is a nicety
	}
	for _, j := range jobs {
		var o Options
		if len(j.Inputs) != 1 || j.Inputs[0] != path || json.Unmarshal([]byte(j.OptionsJSON), &o) != nil || o.Action != ActionMaps {
			continue
		}
		for _, k := range o.MapKinds {
			if !slices.Contains(st.Preparing, k) {
				st.Preparing = append(st.Preparing, k)
			}
		}
	}
	return st, nil
}

// MapsNeeded lists the kinds ("depth", "subject") a recipe's regions need.
func MapsNeeded(r Recipe) []string {
	var out []string
	for _, k := range RegionsUsed(r) {
		if k == "people" {
			k = "subject"
		}
		if !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	return out
}

// runMaps is the maps action: it makes the missing maps of one file.
func (m *Module) runMaps(ctx context.Context, job *core.JobContext, o Options) error {
	path := job.Inputs[0]
	kinds, err := mapKinds(o.MapKinds)
	if err != nil {
		return err
	}
	job.SetTitle("Maps — " + filepath.Base(path))
	if err := m.ensureMaps(ctx, job, path, kinds); err != nil {
		return err
	}
	st, err := m.mapsOf(path)
	if err != nil {
		return err
	}
	job.Progress(1, "Maps ready")
	return job.SetResult(st)
}

// ensureMaps makes the maps of kinds that don't exist yet. "people" is "subject".
func (m *Module) ensureMaps(ctx context.Context, job *core.JobContext, path string, kinds []string) error {
	var want []string
	for _, k := range kinds {
		if k == "people" {
			k = "subject"
		}
		if !slices.Contains(want, k) {
			want = append(want, k)
		}
	}
	if len(want) == 0 {
		return nil
	}
	dir, err := m.cacheDirFor(path)
	if err != nil {
		return err
	}
	video := isVideo(path)
	var todo []string
	for _, k := range want {
		if !m.mapInfo(dir, k, video).Ready {
			todo = append(todo, k)
		}
	}
	if len(todo) == 0 {
		return nil
	}
	// One map build at a time: they're heavy.
	select {
	case m.mapsSem <- struct{}{}:
	default:
		job.Progress(core.IndeterminateProgress, "Waiting for another map")
		select {
		case m.mapsSem <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	defer func() { <-m.mapsSem }()

	for _, k := range todo { // the model check comes before any slow work
		if miss := m.missingModel(k, video); miss != "" {
			return mapsMissing(k, video)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the maps folder").WithCause(err)
	}
	for i, k := range todo {
		sub := job.Scoped(float64(i)/float64(len(todo)), float64(i+1)/float64(len(todo)))
		switch {
		case k == "depth" && !video:
			err = m.depthImage(ctx, sub, path, dir)
		case k == "depth":
			err = m.depthVideo(ctx, sub, path, dir)
		case !video:
			err = m.subjectImage(ctx, sub, path, dir)
		default:
			err = m.subjectVideo(ctx, sub, path, dir)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// mapsMissing is the dependency error naming what to install.
func mapsMissing(kind string, video bool) error {
	switch {
	case kind == "depth":
		return core.ErrDependencyMissing("The depth model", "Install the Color pack in Settings")
	case video:
		return core.ErrDependencyMissing("The people cut-out model", "Install the Music edits tool pack in Settings")
	}
	return core.ErrDependencyMissing("The photo cut-out model", "Install the Image tool pack in Settings")
}

type engineSink struct {
	job *core.JobContext
	msg string
}

func (s engineSink) onEvent(ev sidecar.Event) {
	switch ev.Kind {
	case "progress":
		s.job.Progress(ev.Pct, s.msg)
	case "log":
		stream := core.StreamStdout
		if ev.Level == "warning" || ev.Level == "error" {
			stream = core.StreamStderr
		}
		s.job.Log(stream, ev.Line)
	}
}

func (m *Module) engine(job *core.JobContext) (sidecar.Caller, error) {
	if m.cfg.Caller == nil {
		return nil, core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return nil, err
	}
	return m.cfg.Caller, nil
}

func (m *Module) depthImage(ctx context.Context, job *core.JobContext, path, dir string) error {
	eng, err := m.engine(job)
	if err != nil {
		return err
	}
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return err
	}
	out := filepath.Join(dir, "depth.png")
	job.Progress(core.IndeterminateProgress, "Estimating depth")
	if _, err := eng.Call(ctx, "depth.image", map[string]any{"path": readable, "model": m.DepthModelPath(), "out": out}, engineSink{job, "Estimating depth"}.onEvent); err != nil {
		return err
	}
	return writeGrayThumb(out, filepath.Join(dir, "depth-thumb.png"))
}

func (m *Module) subjectImage(ctx context.Context, job *core.JobContext, path, dir string) error {
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return err
	}
	out := filepath.Join(dir, "subject.png")
	if err := m.cfg.Edit.RunImageMatte(ctx, job, readable, out); err != nil {
		return err
	}
	return writeGrayThumb(out, filepath.Join(dir, "subject-thumb.png"))
}

// probeVideo reads a video's upright size, frame rate and duration.
func (m *Module) probeVideo(ctx context.Context, job *core.JobContext, path string) (w, h, fps int, durMs int64, ffmpeg string, err error) {
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return 0, 0, 0, 0, "", err
	}
	if ffmpeg, err = job.Tool("ffmpeg"); err != nil {
		return 0, 0, 0, 0, "", err
	}
	info, err := mediaProbeFn(ctx, ffprobe, path)
	if err != nil {
		return 0, 0, 0, 0, "", err
	}
	if info.Video == nil {
		return 0, 0, 0, 0, "", core.ValidationError("This file has no video", nil)
	}
	return info.Video.Width, info.Video.Height, pickFPS(info.Video.FPS), info.DurationMs, ffmpeg, nil
}

func (m *Module) depthVideo(ctx context.Context, job *core.JobContext, path, dir string) error {
	eng, err := m.engine(job)
	if err != nil {
		return err
	}
	if m.cfg.Edit == nil {
		return core.Errorf(core.CodeInternal, "The video engine isn't available")
	}
	w, h, fps, _, ffmpeg, err := m.probeVideo(ctx, job, path)
	if err != nil {
		return err
	}
	prep := job.Scoped(0, 0.1)
	stream, index, sw, sh, _, err := m.cfg.Edit.PrepareStream(ctx, prep, path, min(min(w, h), depthStreamShort), fps, func(p float64) { prep.Progress(p, "Preparing the clip") })
	if err != nil {
		return err
	}
	run := job.Scoped(0.1, 1)
	raw, err := eng.Call(ctx, "depth.video", map[string]any{
		"ffmpeg": ffmpeg, "stream": stream, "index": index, "fps": fps, "width": sw, "height": sh,
		"outDir": dir, "name": "depth", "model": m.DepthModelPath(),
	}, engineSink{run, "Estimating depth"}.onEvent)
	if err != nil {
		return err
	}
	var wire struct {
		Export        string `json:"exportPath"`
		Preview       string `json:"previewPath"`
		Width         int    `json:"width"`
		Height        int    `json:"height"`
		PreviewWidth  int    `json:"previewWidth"`
		PreviewHeight int    `json:"previewHeight"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil || wire.Export == "" || wire.Preview == "" {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	if err := m.cfg.Edit.WriteStreamIndex(wire.Export, wire.Width, wire.Height, fps); err != nil {
		return err
	}
	if err := m.cfg.Edit.WriteStreamIndex(wire.Preview, wire.PreviewWidth, wire.PreviewHeight, fps); err != nil {
		return err
	}
	return m.streamThumb(ctx, ffmpeg, wire.Preview, fps, filepath.Join(dir, "depth-thumb.png"))
}

func (m *Module) subjectVideo(ctx context.Context, job *core.JobContext, path, dir string) error {
	w, h, fps, dur, ffmpeg, err := m.probeVideo(ctx, job, path)
	if err != nil {
		return err
	}
	_, preview, err := m.cfg.Edit.RunMatte(ctx, job, path, dir, "subject", 0, dur, fps, min(min(w, h), matteStreamShort))
	if err != nil {
		return err
	}
	return m.streamThumb(ctx, ffmpeg, preview.Stream, fps, filepath.Join(dir, "subject-thumb.png"))
}

// streamThumb writes the 12th frame (or the first) of a grey Annex-B stream as a 256 px PNG.
func (m *Module) streamThumb(ctx context.Context, ffmpeg, stream string, fps int, out string) error {
	for _, vf := range []string{`select=eq(n\,12),scale=256:-2`, `scale=256:-2`} {
		part := out + ".part.png"
		_, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: []string{
			"-hide_banner", "-loglevel", "error", "-nostdin", "-f", "h264", "-framerate", fmt.Sprint(fps), "-i", stream,
			"-vf", vf, "-frames:v", "1", "-y", part,
		}})
		if err == nil && regular(part) {
			return os.Rename(part, out)
		}
		_ = os.Remove(part)
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	return nil // the thumbnail is a nicety
}

// writeGrayThumb writes a 256 px 8-bit grey copy of a (16-bit) map PNG.
func writeGrayThumb(src, dst string) error {
	f, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("opening the map: %w", err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return core.Errorf(core.CodeInternal, "The map couldn't be read").WithCause(err)
	}
	b := img.Bounds()
	tw := min(256, b.Dx())
	th := max(1, b.Dy()*tw/max(b.Dx(), 1))
	small := image.NewGray(image.Rect(0, 0, tw, th))
	xdraw.ApproxBiLinear.Scale(small, small.Bounds(), img, b, xdraw.Src, nil)
	part := dst + ".part"
	out, err := os.Create(part)
	if err != nil {
		return fmt.Errorf("writing the map thumbnail: %w", err)
	}
	err = png.Encode(out, small)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("writing the map thumbnail: %w", err)
	}
	return os.Rename(part, dst)
}

// PruneCache deletes map folders untouched for 30 days, then the oldest until
// the cache is under 5 GB (called at start).
func (m *Module) PruneCache() { pruneCache(m.cfg.CacheDir, CacheMaxAgeDays, CacheMaxBytes) }

type cacheEntry struct {
	path string
	mod  time.Time
	size int64
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, e := d.Info(); e == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n
}

func pruneCache(root string, maxAgeDays int, maxBytes int64) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var all []cacheEntry
	var total int64
	cutoff := time.Now().Add(-time.Duration(maxAgeDays) * 24 * time.Hour)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(root, e.Name())
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if e.Name() == "read" { // Read's stills are removed right away; anything left is old
			if fi.ModTime().Before(time.Now().Add(-time.Hour)) {
				_ = os.RemoveAll(p)
			}
			continue
		}
		if fi.ModTime().Before(cutoff) {
			_ = os.RemoveAll(p)
			continue
		}
		c := cacheEntry{path: p, mod: fi.ModTime(), size: dirSize(p)}
		all = append(all, c)
		total += c.size
	}
	slices.SortFunc(all, func(a, b cacheEntry) int { return a.mod.Compare(b.mod) })
	for _, c := range all {
		if total <= maxBytes {
			break
		}
		if os.RemoveAll(c.path) == nil {
			total -= c.size
		}
	}
}

// touchDir marks a map folder as used (its modification time drives pruning).
func touchDir(dir string) {
	now := time.Now()
	_ = os.Chtimes(dir, now, now)
}
