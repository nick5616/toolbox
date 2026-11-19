package editstudio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/viz"
	"toolbox/modules/videoeditor"
)

// Edit streams, prepare jobs and source state (SPEC.md §7.1, §7.6). WP-ES4.

// notBuilt is what a Wave 0 stub returns until its work package lands.
func notBuilt(what string) error {
	return core.Errorf(core.CodeInternal, "%s isn't built yet", what)
}

// Seams for tests.
var (
	runFFmpeg     = proc.Run
	probeMedia    = media.Probe
	probeFiles    = videoeditor.ProbeFiles
	probeTransfer = ffprobeTransfer
	ffmpegFilters = listFilters
)

// Tier is which copy of a source a stream is.
type Tier string

const (
	TierPreview Tier = "preview" // short side ≤ 540, for the live preview
	TierExport  Tier = "export"  // short side ≤ the output's long side
)

// previewShortMax is the preview tier's largest short side.
const previewShortMax = 540

// PreviewShort is the preview tier's short side for an upright source of w×h.
func PreviewShort(w, h int) int { return min(min(w, h), previewShortMax) }

// ExportShort is the export tier's short side for a source of w×h and an
// output of outW×outH.
func ExportShort(w, h, outW, outH int) int { return min(min(w, h), max(outW, outH)) }

// evenSize rounds to the nearest even number, at least 2.
func evenSize(v float64) int { return max(2, 2*int(math.Round(v/2))) }

// streamSize is the even width and height of a stream whose short side is
// `short` for an upright source of w×h. The short side never grows past the source's.
func streamSize(w, h, short int) (int, int) {
	short = min(short, min(w, h))
	if w <= h {
		return evenSize(float64(short)), evenSize(float64(short) * float64(h) / float64(w))
	}
	return evenSize(float64(short) * float64(w) / float64(h)), evenSize(float64(short))
}

// Encoder quality (§7.1).
const (
	crfPreview = 20
	crfExport  = 16
)

// hdrPrefix is the tone-mapping filter chain that precedes the scale filter.
const hdrPrefix = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"

// encodeArgs are the x264 settings every edit stream shares.
func encodeArgs(crf int) []string {
	return []string{
		"-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", strconv.Itoa(crf),
		"-profile:v", "high", "-bf", "0", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0",
		"-x264-params", "aud=1:repeat-headers=1", "-f", "h264",
	}
}

// streamArgs is the FFmpeg command line that makes an edit stream.
func streamArgs(src, out string, w, h, fps, crf int, hdr bool) []string {
	vf := fmt.Sprintf("scale=%d:%d:flags=bicubic,setsar=1,fps=%d,format=yuv420p", w, h, fps)
	if hdr {
		vf = hdrPrefix + vf
	}
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
		"-i", src, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", vf,
	}
	args = append(args, encodeArgs(crf)...)
	return append(args, out)
}

// crfFor is the quality for a stream by short side: the preview tier is
// anything at or below previewShortMax.
func crfFor(short int) int {
	if short <= previewShortMax {
		return crfPreview
	}
	return crfExport
}

// isHDR reports whether a colour transfer is PQ or HLG.
func isHDR(transfer string) bool {
	return transfer == "smpte2084" || transfer == "arib-std-b67"
}

// ---- cache layout ----

func (m *Module) srcRoot() string { return filepath.Join(m.cfg.CacheDir, "src") }

// srcDir is the cache folder of a source file.
func (m *Module) srcDir(path string) (string, error) {
	key, err := viz.FileKey(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "This file doesn't exist any more").WithHint(path).WithCause(err)
	}
	return filepath.Join(m.srcRoot(), key), nil
}

func streamName(short, fps int) string { return fmt.Sprintf("v%d-%d.h264", short, fps) }

// touchDir marks a cache folder as used (pruning looks at its mtime).
func touchDir(dir string) {
	now := time.Now()
	_ = os.Chtimes(dir, now, now)
}

// readStream loads a finished stream (index valid, file the size the index says).
func readStream(stream string) *EditStream {
	idx, err := ReadIndex(stream)
	if err != nil {
		return nil
	}
	fi, err := os.Stat(stream)
	if err != nil || fi.Size() != idx.Bytes {
		return nil
	}
	return &EditStream{Stream: stream, Index: IndexPath(stream), Width: idx.Width, Height: idx.Height, FPS: idx.FPS, Frames: idx.Frames}
}

// StreamFor returns an existing edit stream, or nil.
func (m *Module) StreamFor(path string, short, fps int) *EditStream {
	dir, err := m.srcDir(path)
	if err != nil {
		return nil
	}
	es := readStream(filepath.Join(dir, streamName(short, fps)))
	if es != nil {
		touchDir(dir)
	}
	return es
}

// ---- tools and logging ----

func logf(job *core.JobContext, format string, args ...any) {
	if job != nil {
		job.Logf(format, args...)
	}
}

// tool resolves a dependency through the job, or the module's resolver.
func (m *Module) tool(job *core.JobContext, id string) (string, error) {
	if job != nil {
		return job.Tool(id)
	}
	if m.cfg.Resolve != nil {
		return m.cfg.Resolve(id)
	}
	return "", core.ErrDependencyMissing(id, "")
}

// lockKey takes the per-key mutex, waiting while another job holds it.
func (m *Module) lockKey(ctx context.Context, key string) (unlock func(), err error) {
	v, _ := m.locks.LoadOrStore(key, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	for !mu.TryLock() {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	return mu.Unlock, nil
}

// ffprobeTransfer reads the first video stream's colour transfer.
func ffprobeTransfer(ctx context.Context, ffprobe, path string) (string, error) {
	var out strings.Builder
	_, err := proc.Run(ctx, proc.Spec{
		Path:     ffprobe,
		Args:     []string{"-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer", "-of", "default=noprint_wrappers=1:nokey=1", path},
		OnStdout: func(l string) { out.WriteString(strings.TrimSpace(l)) },
	})
	return out.String(), err
}

// listFilters reports whether FFmpeg has the filters HDR tone mapping needs.
func listFilters(ctx context.Context, ffmpeg string) (bool, error) {
	var zscale, tonemap bool
	_, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: []string{"-hide_banner", "-filters"},
		OnStdout: func(l string) {
			f := strings.Fields(l)
			if len(f) >= 2 {
				switch f[1] {
				case "zscale":
					zscale = true
				case "tonemap":
					tonemap = true
				}
			}
		},
	})
	return zscale && tonemap, err
}

var filterCache sync.Map // ffmpeg path → bool

// canToneMap reports (once per FFmpeg path) whether zscale and tonemap exist.
func canToneMap(ctx context.Context, ffmpeg string) bool {
	if v, ok := filterCache.Load(ffmpeg); ok {
		return v.(bool)
	}
	ok, err := ffmpegFilters(ctx, ffmpeg)
	if err != nil {
		return false // not cached: the failure may be a cancel
	}
	filterCache.Store(ffmpeg, ok)
	return ok
}

// ---- probing ----

// srcInfo is what a stream needs to know about a video.
type srcInfo struct {
	W, H       int // upright (rotation applied)
	DurationMs int64
}

func (m *Module) probeVideo(ctx context.Context, ffprobe, path string) (srcInfo, error) {
	info, err := probeMedia(ctx, ffprobe, path)
	if err != nil {
		return srcInfo{}, err
	}
	if info.Video == nil || info.Video.Width <= 0 || info.Video.Height <= 0 {
		return srcInfo{}, core.Errorf(core.CodeValidation, "This file has no picture").WithHint(filepath.Base(path))
	}
	return srcInfo{W: info.Video.Width, H: info.Video.Height, DurationMs: info.DurationMs}, nil
}

// ---- streams ----

// ffmpegError turns a failed FFmpeg run into a user-facing error.
func ffmpegError(what string, res proc.Result, err error) error {
	hint := ""
	if n := len(res.StderrTail); n > 0 {
		hint = res.StderrTail[n-1]
	}
	return core.Errorf(core.CodeToolFailed, "FFmpeg couldn't %s", what).WithHint(hint).WithCause(err)
}

// transcodeTo runs FFmpeg (args end with out+".part"), indexes the result and
// renames it into place. Partial files are removed on failure and on cancel.
func (m *Module) transcodeTo(ctx context.Context, job *core.JobContext, ffmpeg string, args []string, out string, durSec float64, label string, w, h, fps int, onProgress func(float64)) (StreamIndex, error) {
	part := out + ".part"
	idxPath := IndexPath(out)
	cleanup := func() {
		_ = os.Remove(part)
		_ = os.Remove(idxPath)
		_ = os.Remove(idxPath + ".part")
	}
	tracker := media.ProgressTracker{Duration: durSec, Label: label}
	res, err := runFFmpeg(ctx, proc.Spec{
		Path: ffmpeg, Args: args,
		OnStdout: func(line string) {
			if pct, _, ok := tracker.Apply(line); ok && onProgress != nil && pct >= 0 {
				onProgress(pct)
			}
		},
		OnStderr: func(line string) {
			if job != nil {
				job.Log(core.StreamStderr, line)
			}
		},
	})
	if err != nil {
		cleanup()
		if ctx.Err() != nil {
			return StreamIndex{}, ctx.Err()
		}
		return StreamIndex{}, ffmpegError("make this stream", res, err)
	}
	// The index goes in first and the stream is renamed last, so a half-done
	// pair never looks complete (readStream wants both).
	idx, err := writeIndexAs(part, idxPath, w, h, fps)
	if err != nil {
		cleanup()
		return StreamIndex{}, indexError(err)
	}
	if err := os.Rename(part, out); err != nil {
		cleanup()
		return StreamIndex{}, core.Errorf(core.CodeInternal, "Couldn't save the stream").WithCause(err)
	}
	if onProgress != nil {
		onProgress(1)
	}
	return idx, nil
}

// EnsureStream makes (or reuses) the edit stream of path at a short side and
// fps, reporting 0..1 progress. Concurrent calls for one stream wait for one
// transcode.
func (m *Module) EnsureStream(ctx context.Context, job *core.JobContext, path string, short, fps int, onProgress func(float64)) (EditStream, error) {
	if short < 2 || fps < 1 {
		return EditStream{}, core.ValidationError("Bad stream size", map[string]string{"short": "Bad stream size"})
	}
	dir, err := m.srcDir(path)
	if err != nil {
		return EditStream{}, err
	}
	out := filepath.Join(dir, streamName(short, fps))
	if es := readStream(out); es != nil {
		touchDir(dir)
		if onProgress != nil {
			onProgress(1)
		}
		return *es, nil
	}
	ffmpeg, err := m.tool(job, "ffmpeg")
	if err != nil {
		return EditStream{}, err
	}
	ffprobe, err := m.tool(job, "ffprobe")
	if err != nil {
		return EditStream{}, err
	}
	unlock, err := m.lockKey(ctx, out)
	if err != nil {
		return EditStream{}, err
	}
	defer unlock()
	if es := readStream(out); es != nil { // another job made it while we waited
		touchDir(dir)
		if onProgress != nil {
			onProgress(1)
		}
		return *es, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return EditStream{}, core.Errorf(core.CodeInternal, "Couldn't create the cache folder").WithCause(err)
	}
	info, err := m.probeVideo(ctx, ffprobe, path)
	if err != nil {
		return EditStream{}, err
	}
	w, h := streamSize(info.W, info.H, short)
	hdr := false
	if tr, terr := probeTransfer(ctx, ffprobe, path); terr == nil && isHDR(tr) {
		if canToneMap(ctx, ffmpeg) {
			hdr = true
		} else {
			logf(job, "HDR footage may look washed out (this FFmpeg has no tone mapping): %s", filepath.Base(path))
		}
	}
	if err := ctx.Err(); err != nil {
		return EditStream{}, err
	}
	args := streamArgs(path, out+".part", w, h, fps, crfFor(short), hdr)
	idx, err := m.transcodeTo(ctx, job, ffmpeg, args, out, float64(info.DurationMs)/1000, "Preparing", w, h, fps, onProgress)
	if err != nil {
		return EditStream{}, err
	}
	if want := int(math.Round(float64(info.DurationMs) * float64(fps) / 1000)); info.DurationMs > 0 && abs(idx.Frames-want) > 2 {
		logf(job, "%s: made %d frames, expected about %d", filepath.Base(path), idx.Frames, want)
	}
	touchDir(dir)
	return EditStream{Stream: out, Index: IndexPath(out), Width: w, Height: h, FPS: fps, Frames: idx.Frames}, nil
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// previewStream makes (or reuses) the preview-tier stream of a video.
func (m *Module) previewStream(ctx context.Context, job *core.JobContext, path string, fps int, onProgress func(float64)) (EditStream, error) {
	ffprobe, err := m.tool(job, "ffprobe")
	if err != nil {
		return EditStream{}, err
	}
	info, err := m.probeVideo(ctx, ffprobe, path)
	if err != nil {
		return EditStream{}, err
	}
	return m.EnsureStream(ctx, job, path, PreviewShort(info.W, info.H), fps, onProgress)
}

// errText is the message a user should see for err.
func errText(err error) string {
	var ae *core.AppError
	if errors.As(err, &ae) {
		return ae.Message
	}
	return err.Error()
}

// runPrepare is the prepare action: preview streams and shots for videos,
// preview images for photos; per-file failures go into the result.
func (m *Module) runPrepare(ctx context.Context, job *core.JobContext, req PrepareRequest) error {
	n := len(req.Paths)
	if n == 1 {
		job.SetTitle("Preparing 1 clip")
	} else {
		job.SetTitle(fmt.Sprintf("Preparing %d clips", n))
	}
	if _, err := job.Tool("ffmpeg"); err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	states := make([]SourceState, 0, n)
	for i, p := range req.Paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		lo, span := float64(i)/float64(n), 1/float64(n)
		job.Progress(lo, fmt.Sprintf("%s (%d of %d)", filepath.Base(p), i+1, n))
		st := m.prepareOne(ctx, job, ffprobe, p, req.FPS, func(f float64) { job.Progress(lo+span*f, filepath.Base(p)) })
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if st.Error != "" {
			job.Logf("%s: %s", filepath.Base(p), st.Error)
		}
		states = append(states, st)
	}
	job.Progress(1, "Done")
	return job.SetResult(Result{Action: ActionPrepare, Sources: fitSources(states)})
}

// prepareOne makes what one source needs; failures go into the state's Error.
func (m *Module) prepareOne(ctx context.Context, job *core.JobContext, ffprobe, path string, fps int, progress func(float64)) SourceState {
	st := SourceState{Path: path}
	st.Info = probeFiles(ctx, ffprobe, []string{path})[0]
	if st.Info.Error != "" {
		st.Error = st.Info.Error
		return st
	}
	switch st.Info.Kind {
	case "image":
		img, err := m.EnsureImage(ctx, job, path, PreviewImageMax)
		if err != nil {
			st.Error = errText(err)
			return st
		}
		st.Image = img
		progress(1)
	case "video":
		es, err := m.EnsureStream(ctx, job, path, PreviewShort(st.Info.Width, st.Info.Height), fps, func(f float64) { progress(0.7 * f) })
		if err != nil {
			st.Error = errText(err)
			return st
		}
		st.Preview = &es
		shots, err := m.EnsureShots(ctx, job, path, fps)
		if err != nil {
			st.Error = errText(err)
			return st
		}
		st.Shots = shots
		progress(0.8)
		if st.Info.HasAudio {
			// The picture is usable without its sound: a failure here is logged, not the source's error.
			a, p, aerr := m.EnsureAudio(ctx, job, path, float64(st.Info.DurationMs)/1000, func(f float64) { progress(0.8 + 0.2*f) })
			if aerr != nil {
				if ctx.Err() == nil {
					logf(job, "%s: couldn't prepare the sound: %s", filepath.Base(path), errText(aerr))
				}
			} else {
				st.Audio, st.Peaks = a, p
			}
		}
		progress(1)
	case "audio":
		a, p, err := m.EnsureAudio(ctx, job, path, float64(st.Info.DurationMs)/1000, progress)
		if err != nil {
			st.Error = errText(err)
			return st
		}
		st.Audio, st.Peaks = a, p
	default:
		st.Error = "Only videos, photos and audio files can be used here"
	}
	return st
}

// fitSources trims a prepare result until it fits a job result (64 KB): first
// the details the UI can ask Sources for, then every entry that succeeded
// (failures always stay, matched by Path).
func fitSources(states []SourceState) []SourceState {
	size := func(v []SourceState) int {
		b, _ := json.Marshal(v)
		return len(b) + 128
	}
	for _, strip := range []func(*SourceState){
		func(s *SourceState) { s.Shots = nil },
		func(s *SourceState) { s.Info = videoeditor.ClipInfo{} },
		func(s *SourceState) { s.Preview, s.Image, s.Audio, s.Peaks = nil, "", "", "" },
	} {
		if size(states) <= core.MaxResultBytes {
			return states
		}
		for i := range states {
			strip(&states[i])
		}
	}
	if size(states) <= core.MaxResultBytes {
		return states
	}
	failed := make([]SourceState, 0, len(states))
	for _, s := range states {
		if s.Error != "" {
			failed = append(failed, s)
		}
	}
	return failed
}

// sourceStates reports what exists for paths at fps without doing work
// (Preparing is filled in by the service from the running jobs).
func (m *Module) sourceStates(ctx context.Context, paths []string, fps int) ([]SourceState, error) {
	var infos []videoeditor.ClipInfo
	if m.cfg.Resolve != nil {
		if ffprobe, err := m.cfg.Resolve("ffprobe"); err == nil && ffprobe != "" {
			infos = probeFiles(ctx, ffprobe, paths)
		}
	}
	out := make([]SourceState, 0, len(paths))
	for i, p := range paths {
		st := SourceState{Path: p}
		if i < len(infos) {
			st.Info = infos[i]
			st.Error = st.Info.Error
		}
		kind := st.Info.Kind
		if kind == "" {
			kind = kindByExt(p)
		}
		switch kind {
		case "image":
			st.Image = m.ImageFor(p, PreviewImageMax)
		case "video":
			if st.Info.Width > 0 && st.Info.Height > 0 {
				st.Preview = m.StreamFor(p, PreviewShort(st.Info.Width, st.Info.Height), fps)
			} else {
				st.Preview = m.anyPreview(p, fps)
			}
			st.Shots = m.ShotsFor(p)
			st.Audio, st.Peaks = m.AudioFor(p)
		case "audio":
			st.Audio, st.Peaks = m.AudioFor(p)
		}
		out = append(out, st)
	}
	return out, nil
}

// kindByExt guesses a file's kind from its extension (used when it can't be probed).
func kindByExt(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch {
	case slices.Contains(media.ImageExtensions(), ext):
		return "image"
	case slices.Contains(media.VideoExtensions(), ext):
		return "video"
	case slices.Contains(media.AudioExtensions(), ext):
		return "audio"
	}
	return ""
}

// anyPreview finds the smallest finished stream of a source at fps (when its
// size is unknown).
func (m *Module) anyPreview(path string, fps int) *EditStream {
	dir, err := m.srcDir(path)
	if err != nil {
		return nil
	}
	files, _ := filepath.Glob(filepath.Join(dir, fmt.Sprintf("v*-%d.h264", fps)))
	var best *EditStream
	for _, f := range files {
		if es := readStream(f); es != nil && (best == nil || min(es.Width, es.Height) < min(best.Width, best.Height)) {
			best = es
		}
	}
	return best
}
