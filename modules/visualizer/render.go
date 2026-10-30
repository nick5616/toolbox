package visualizer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// Seams: tests replace these so the logic runs without the engine, the
// webview renderer or FFmpeg.
var (
	analyzeFn = func(ctx context.Context, an *viz.Analyzer, job *core.JobContext, input string, o viz.AnalyzeOptions) (viz.AnalysisRef, error) {
		return an.Analyze(ctx, job, input, o)
	}
	renderFn = func(ctx context.Context, br *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
		return br.Render(ctx, job, plan)
	}
	muxFn       = viz.MuxOpaque
	compositeFn = viz.CompositeOverlay
	probeFn     = media.Probe
	coverFn     = extractCover
	cutAudioFn  = cutAudio
	cutVideoFn  = cutVideo
	nowFn       = time.Now
)

// run is the job body (SPEC.md §5.1, §7.1).
func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return bad("inputs", "Add one song or video")
	}
	if err := m.validateOptions(job.Inputs, o); err != nil {
		return err
	}
	switch o.Action {
	case ActionAnalyze:
		return m.runAnalyze(ctx, job, o)
	default:
		return m.runRender(ctx, job, o)
	}
}

func (m *Module) runAnalyze(ctx context.Context, job *core.JobContext, o Options) error {
	input := job.Inputs[0]
	job.SetTitle("Analyzing — " + filepath.Base(input))
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	ref, err := analyzeFn(ctx, m.an, job, input, o.Analyze)
	if err != nil {
		return err
	}
	return job.SetResult(Result{Action: ActionAnalyze, Analysis: &ref})
}

// sizes holds the resolved sizes of a render job.
type sizes struct {
	planW, planH   int // what the renderer draws
	finalW, finalH int // the output video (overlay compositing)
	fps            int
}

func resolveSizes(o Options, preview bool, info media.Info) (sizes, error) {
	var s sizes
	if o.Mode == ModeOverlay {
		if info.Video == nil {
			return s, bad("mode", "Visuals over the video need a video file")
		}
		s.finalW, s.finalH = info.Video.Width, info.Video.Height
		if preview {
			s.finalW, s.finalH = capShort(s.finalW, s.finalH, previewMaxShort)
		}
		s.finalW, s.finalH, s.planW, s.planH = overlaySizes(s.finalW, s.finalH)
		s.fps = roundFPS(info.Video.FPS)
		return s, nil
	}
	w, h := fullSize(o.Aspect, o.Height)
	if preview {
		w, h = capShort(w, h, previewMaxShort)
	}
	s.planW, s.planH, s.finalW, s.finalH, s.fps = w, h, w, h, o.FPS
	return s, nil
}

func (m *Module) runRender(ctx context.Context, job *core.JobContext, o Options) error {
	start := nowFn()
	input := job.Inputs[0]
	preview := o.Action == ActionPreview
	job.SetTitle("Rendering visuals — " + filepath.Base(input))

	ref, ok := m.an.Lookup(o.AnalysisKey)
	if !ok {
		return bad("analysisKey", "Analyze the file again")
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	info, err := probeFn(ctx, ffprobe, input)
	if err != nil {
		return err
	}
	dur := info.DurationMs
	if dur <= 0 {
		dur = ref.Summary.DurationMs
	}
	from, to, ok := renderRange(preview, o.StartMs, o.EndMs, o.PreviewStartMs, dur)
	if !ok {
		return bad("endMs", "The range is empty")
	}
	sz, err := resolveSizes(o, preview, info)
	if err != nil {
		return err
	}

	overlay := o.Mode == ModeOverlay
	videoBg := !overlay && o.Background == "video"
	composite := overlay || videoBg

	plan := viz.RenderPlan{
		Analysis: ref, ShowJSON: o.ShowJSON, Width: sz.planW, Height: sz.planH, FPS: sz.fps,
		StartMs: from, EndMs: to, Mode: viz.ModeOpaque, Seed: o.Seed,
	}
	if composite {
		plan.Mode = viz.ModeOverlay
	}
	if info.HasCover && (o.Background == "cover" || overlay) {
		if p, err := coverFn(ctx, ffmpeg, input, job.TempDir); err == nil {
			plan.CoverPath = p
		} else if ctx.Err() != nil {
			return fmt.Errorf("render cancelled: %w", ctx.Err())
		}
	} else if o.Background == "cover" && !overlay {
		job.Logf("This file has no cover art, so there is no cover texture.")
	}
	if !overlay && o.Background == "image" {
		plan.ImagePath = o.BackgroundPath
	}

	renderTo := 0.9
	if composite {
		renderTo = 0.5
	}
	enc, err := renderFn(ctx, m.br, job.Scoped(0, renderTo), plan)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return fmt.Errorf("render cancelled: %w", ctx.Err())
	}

	audio := chooseAudio(o.Audio, input, ref.Instrumental, overlay)
	out := filepath.Join(job.TempDir, "visualizer.mp4")
	if !composite {
		job.Progress(renderTo, "Adding the audio…")
		err = muxFn(ctx, ffmpeg, enc, audio, from, to, sz.fps, "", out, func(p float64) {
			job.Progress(renderTo+p*(1-renderTo), "Adding the audio…")
		})
	} else {
		base, baseAudio := input, audio
		loop := videoBg
		if videoBg {
			base = o.BackgroundPath
		}
		if partialRange(from, to, dur) {
			job.Progress(renderTo, "Preparing the media…")
			if baseAudio != "" {
				if baseAudio, err = cutAudioFn(ctx, ffmpeg, baseAudio, from, to, job.TempDir); err != nil {
					return cutErr(ctx, err)
				}
			}
			if overlay {
				if base, err = cutVideoFn(ctx, ffmpeg, base, from, to, job.TempDir); err != nil {
					return cutErr(ctx, err)
				}
			}
		}
		job.Progress(renderTo, "Compositing…")
		err = compositeFn(ctx, ffmpeg, enc, base, loop, baseAudio, sz.fps, sz.finalW, sz.finalH, "", out, func(p float64) {
			job.Progress(renderTo+p*(1-renderTo), "Compositing…")
		})
	}
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("render cancelled: %w", ctx.Err())
		}
		return err
	}

	res := Result{Action: o.Action, Outputs: []string{}, Encoder: enc.Encoder}
	if wall := nowFn().Sub(start).Seconds(); wall > 0 {
		res.Speed = float64(to-from) / 1000 / wall
	}
	if preview {
		if err := os.MkdirAll(m.previewDir, 0o755); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't create the preview folder").WithCause(err)
		}
		dst := previewPath(m.previewDir, job.ID)
		if err := moveFile(out, dst); err != nil {
			return core.Errorf(core.CodeToolFailed, "Couldn't save the preview").WithCause(err)
		}
		res.PreviewPath = dst
		job.Progress(1, "Preview ready")
		return job.SetResult(res)
	}
	final := core.UniquePath(job.OutputDir, outputName(input), ".mp4")
	if err := moveFile(out, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the video").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	res.Outputs = append(res.Outputs, final)
	job.Progress(1, "Saved "+filepath.Base(final))
	return job.SetResult(res)
}

func cutErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("render cancelled: %w", ctx.Err())
	}
	return err
}

// extractCover saves the file's attached picture as cover.png in dir.
func extractCover(ctx context.Context, ffmpeg, src, dir string) (string, error) {
	out := filepath.Join(dir, "cover.png")
	_, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Dir: dir,
		Args: []string{"-y", "-hide_banner", "-loglevel", "error", "-i", src, "-map", "0:v:0", "-frames:v", "1", "cover.png"},
	})
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("extract cover: %w", err)
	}
	if fi, err := os.Stat(out); err != nil || !fi.Mode().IsRegular() {
		return "", errors.New("no cover written")
	}
	return out, nil
}

// cutArgs are the FFmpeg arguments that cut src to from..to ms.
func cutArgs(src string, from, to int64, codec []string, out string) []string {
	a := []string{"-y", "-hide_banner", "-loglevel", "error", "-ss", secs(from), "-t", secs(to - from), "-i", src}
	a = append(a, codec...)
	return append(a, out)
}

func runFFmpeg(ctx context.Context, ffmpeg, dir string, args []string) error {
	var last string
	_, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Dir: dir, Args: args, OnStderr: func(l string) {
		if strings.TrimSpace(l) != "" {
			last = l
		}
	}})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if last == "" {
			last = "ffmpeg failed"
		}
		return core.Errorf(core.CodeToolFailed, "%s", last).WithCause(err)
	}
	return nil
}

// cutAudio cuts an audio file to from..to into dir (the composite step has no
// range of its own).
func cutAudio(ctx context.Context, ffmpeg, src string, from, to int64, dir string) (string, error) {
	out := filepath.Join(dir, "audio-cut.flac")
	err := runFFmpeg(ctx, ffmpeg, dir, cutArgs(src, from, to, []string{"-vn", "-c:a", "flac"}, out))
	return out, err
}

// cutVideo cuts the base video to from..to into dir, re-encoded so the cut is
// frame-accurate.
func cutVideo(ctx context.Context, ffmpeg, src string, from, to int64, dir string) (string, error) {
	out := filepath.Join(dir, "base-cut.mp4")
	codec := []string{"-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
		"-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k"}
	err := runFFmpeg(ctx, ffmpeg, dir, cutArgs(src, from, to, codec, out))
	return out, err
}

// moveFile renames src to dst, copying across volumes when needed.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, in); err != nil {
		f.Close()
		os.Remove(dst)
		return err
	}
	return f.Close()
}

// prunePreviews deletes preview-*.mp4 older than a day.
func (m *Module) prunePreviews() {
	if m.previewDir == "" {
		return
	}
	pruneOlder(m.previewDir, 24*time.Hour, nowFn())
}

func pruneOlder(dir string, age time.Duration, now time.Time) {
	matches, _ := filepath.Glob(filepath.Join(dir, "preview-*.mp4"))
	for _, p := range matches {
		fi, err := os.Stat(p)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		if now.Sub(fi.ModTime()) > age {
			_ = os.Remove(p)
		}
	}
}
