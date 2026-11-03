package editstudio

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"toolbox/core"
)

// Interpolated slow motion with FFmpeg minterpolate (SPEC.md §7.5). WP-ES4.

const (
	interpFactor = 4 // output fps = 4 × project fps
	// interpExportShortMax caps the export-tier input of minterpolate: it is
	// by far the slowest step, and its result is only used for slow motion.
	interpExportShortMax = 1080
)

// InterpRange rounds a source range out to whole seconds.
func InterpRange(fromMs, toMs int64) (fromS, toS int64) {
	return fromMs / 1000, (toMs + 999) / 1000
}

// InterpFrameMs is the source time (ms) frame n of an interp stream shows.
func InterpFrameMs(fromS int64, fps, n int) int64 {
	return fromS*1000 + int64(n)*1000/int64(interpFactor*fps)
}

func interpName(fromS, toS int64, fps int, tier Tier) string {
	return fmt.Sprintf("interp-%d-%d-%d-%s.h264", fromS, toS, interpFactor*fps, tier)
}

// interpArgs is the FFmpeg command line that interpolates a range of an
// export stream. The range is trimmed on the output side: raw H.264 can't be
// seeked.
func interpArgs(src, out string, fromS, toS int64, fps, crf int) []string {
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
		"-f", "h264", "-framerate", strconv.Itoa(fps), "-i", src,
		"-ss", strconv.FormatInt(fromS, 10), "-t", strconv.FormatInt(toS-fromS, 10),
		"-vf", fmt.Sprintf("minterpolate=fps=%d:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1", interpFactor*fps),
	}
	args = append(args, encodeArgs(crf)...)
	return append(args, out)
}

// interpPreviewArgs scales an interp export stream down to the preview copy.
func interpPreviewArgs(src, out string, w, h, outFPS int) []string {
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
		"-f", "h264", "-framerate", strconv.Itoa(outFPS), "-i", src,
		"-vf", fmt.Sprintf("scale=%d:%d:flags=bicubic,setsar=1,format=yuv420p", w, h),
	}
	args = append(args, encodeArgs(crfPreview)...)
	return append(args, out)
}

// stage maps a 0..1 stage progress into [lo, hi] of the whole.
func stage(onProgress func(float64), lo, hi float64) func(float64) {
	if onProgress == nil {
		return nil
	}
	return func(f float64) { onProgress(lo + (hi-lo)*f) }
}

// EnsureInterp makes (or reuses) the 4×-fps streams for a source range.
func (m *Module) EnsureInterp(ctx context.Context, job *core.JobContext, path string, fromMs, toMs int64, fps int, onProgress func(float64)) (preview, export EditStream, err error) {
	if fps < 1 || toMs <= fromMs || fromMs < 0 {
		return EditStream{}, EditStream{}, core.ValidationError("Bad slow-motion range", map[string]string{"range": "Bad slow-motion range"})
	}
	fromS, toS := InterpRange(fromMs, toMs)
	dir, err := m.srcDir(path)
	if err != nil {
		return EditStream{}, EditStream{}, err
	}
	expPath := filepath.Join(dir, interpName(fromS, toS, fps, TierExport))
	prevPath := filepath.Join(dir, interpName(fromS, toS, fps, TierPreview))
	existing := func() bool {
		p, e := readStream(prevPath), readStream(expPath)
		if p == nil || e == nil {
			return false
		}
		preview, export = *p, *e
		return true
	}
	if existing() {
		touchDir(dir)
		return preview, export, nil
	}
	ffmpeg, err := m.tool(job, "ffmpeg")
	if err != nil {
		return EditStream{}, EditStream{}, err
	}
	ffprobe, err := m.tool(job, "ffprobe")
	if err != nil {
		return EditStream{}, EditStream{}, err
	}
	unlock, err := m.lockKey(ctx, expPath)
	if err != nil {
		return EditStream{}, EditStream{}, err
	}
	defer unlock()
	if existing() {
		touchDir(dir)
		return preview, export, nil
	}
	info, err := m.probeVideo(ctx, ffprobe, path)
	if err != nil {
		return EditStream{}, EditStream{}, err
	}
	if fromMs >= info.DurationMs {
		return EditStream{}, EditStream{}, core.ValidationError("That range is past the end of the clip", map[string]string{"range": "Past the end of the clip"})
	}

	// 1. The export-tier input stream (usually exists already).
	in, err := m.EnsureStream(ctx, job, path, min(min(info.W, info.H), interpExportShortMax), fps, stage(onProgress, 0, 0.1))
	if err != nil {
		return EditStream{}, EditStream{}, err
	}

	// 2. minterpolate into the export copy.
	outFPS := interpFactor * fps
	args := interpArgs(in.Stream, expPath+".part", fromS, toS, fps, crfExport)
	idx, err := m.transcodeTo(ctx, job, ffmpeg, args, expPath, float64(toS-fromS), "Slow motion", in.Width, in.Height, outFPS, stage(onProgress, 0.1, 0.9))
	if err != nil {
		return EditStream{}, EditStream{}, err
	}
	export = EditStream{Stream: expPath, Index: IndexPath(expPath), Width: in.Width, Height: in.Height, FPS: outFPS, Frames: idx.Frames}

	// 3. The preview copy.
	pw, ph := streamSize(in.Width, in.Height, min(min(in.Width, in.Height), previewShortMax))
	if min(in.Width, in.Height) <= previewShortMax {
		if err := copyStream(expPath, prevPath, in.Width, in.Height, outFPS); err != nil {
			_ = os.Remove(expPath)
			_ = os.Remove(IndexPath(expPath))
			return EditStream{}, EditStream{}, err
		}
		preview = EditStream{Stream: prevPath, Index: IndexPath(prevPath), Width: in.Width, Height: in.Height, FPS: outFPS, Frames: idx.Frames}
	} else {
		pargs := interpPreviewArgs(expPath, prevPath+".part", pw, ph, outFPS)
		pidx, err := m.transcodeTo(ctx, job, ffmpeg, pargs, prevPath, float64(toS-fromS), "Slow motion", pw, ph, outFPS, stage(onProgress, 0.9, 1))
		if err != nil {
			_ = os.Remove(expPath)
			_ = os.Remove(IndexPath(expPath))
			return EditStream{}, EditStream{}, err
		}
		preview = EditStream{Stream: prevPath, Index: IndexPath(prevPath), Width: pw, Height: ph, FPS: outFPS, Frames: pidx.Frames}
	}
	touchDir(dir)
	if onProgress != nil {
		onProgress(1)
	}
	return preview, export, nil
}

// copyStream copies a stream file and indexes the copy.
func copyStream(src, dst string, w, h, fps int) error {
	in, err := os.Open(src)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't copy the stream").WithCause(err)
	}
	defer in.Close()
	part := dst + ".part"
	out, err := os.Create(part)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't copy the stream").WithCause(err)
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		_, err = writeIndexAs(part, IndexPath(dst), w, h, fps)
	}
	if err == nil {
		err = os.Rename(part, dst)
	}
	if err != nil {
		_ = os.Remove(part)
		_ = os.Remove(IndexPath(dst))
		return core.Errorf(core.CodeInternal, "Couldn't copy the stream").WithCause(err)
	}
	return nil
}

// InterpFor returns an existing interp stream of a tier, or nil.
func (m *Module) InterpFor(path string, fromMs, toMs int64, fps int, tier Tier) *EditStream {
	dir, err := m.srcDir(path)
	if err != nil {
		return nil
	}
	fromS, toS := InterpRange(fromMs, toMs)
	es := readStream(filepath.Join(dir, interpName(fromS, toS, fps, tier)))
	if es != nil {
		touchDir(dir)
	}
	return es
}

// runInterp is the interp action.
func (m *Module) runInterp(ctx context.Context, job *core.JobContext, req InterpRequest) error {
	job.SetTitle("Slow motion — " + filepath.Base(req.Path))
	if _, err := job.Tool("ffmpeg"); err != nil {
		return err
	}
	if _, err := job.Tool("ffprobe"); err != nil {
		return err
	}
	preview, _, err := m.EnsureInterp(ctx, job, req.Path, req.FromMs, req.ToMs, req.FPS, func(f float64) { job.Progress(f, "Making slow motion") })
	if err != nil {
		return err
	}
	job.Progress(1, "Done")
	return job.SetResult(Result{Action: ActionInterp, Interp: &preview})
}
