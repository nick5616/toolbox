package captions

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// Pictures for the model (SPEC.md §5.3): a photo becomes one oriented JPEG
// of at most 896 px on its long side; a video becomes 6 evenly spaced
// frames. Everything is written into the job's TempDir; the originals are
// only read.

func hasExt(path string, exts []string) bool {
	e := strings.ToLower(filepath.Ext(path))
	for _, x := range exts {
		if e == x {
			return true
		}
	}
	return false
}

func isVideo(path string) bool { return hasExt(path, VideoExts()) }
func isImage(path string) bool { return hasExt(path, ImageExts()) }

// frameTimes are n moments in the middle of n equal parts of a video.
func frameTimes(durationMs int64, n int) []float64 {
	if durationMs <= 0 || n <= 1 {
		return []float64{0}
	}
	out := make([]float64, n)
	for i := range out {
		out[i] = float64(durationMs) * (float64(i) + 0.5) / float64(n) / 1000
	}
	return out
}

// frameArgs is the FFmpeg command for one frame (cwd = the TempDir; the
// filter holds no path).
func frameArgs(input string, at float64, out string) []string {
	return []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-ss", fmt.Sprintf("%.3f", at), "-i", input,
		"-frames:v", "1",
		"-vf", fmt.Sprintf("scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease", ImageMaxPixels, ImageMaxPixels),
		"-q:v", "3", "-y", out,
	}
}

// preparePictures returns the picture files for one input.
func (m *Module) preparePictures(ctx context.Context, job *core.JobContext, input string, idx int) ([]string, error) {
	if isVideo(input) {
		return m.videoFrames(ctx, job, input, idx)
	}
	return m.imageFile(job, input, idx)
}

func (m *Module) imageFile(job *core.JobContext, input string, idx int) ([]string, error) {
	url, err := imaging.ThumbUncached(input, ImageMaxPixels)
	if err != nil {
		return nil, err
	}
	head, data, ok := strings.Cut(url, ",")
	if !ok {
		return nil, core.Errorf(core.CodeInternal, "Couldn't prepare %s", filepath.Base(input))
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return nil, fmt.Errorf("decode picture: %w", err)
	}
	ext := ".jpg"
	if strings.Contains(head, "png") {
		ext = ".png"
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return nil, fmt.Errorf("create temp folder: %w", err)
	}
	out := filepath.Join(job.TempDir, fmt.Sprintf("pic%d%s", idx, ext))
	if err := os.WriteFile(out, raw, 0o600); err != nil {
		return nil, fmt.Errorf("write picture: %w", err)
	}
	return []string{out}, nil
}

var errNeedsFFmpeg = core.Errorf(core.CodeDependencyMissing, "Needs FFmpeg for videos")

func (m *Module) videoFrames(ctx context.Context, job *core.JobContext, input string, idx int) ([]string, error) {
	ffmpeg, err := job.Tool(deps.FFmpeg)
	if err != nil {
		return nil, errNeedsFFmpeg
	}
	var durMs int64
	if ffprobe, err := job.Tool(deps.FFprobe); err == nil {
		if d, err := m.probeDuration(ctx, ffprobe, input); err == nil {
			durMs = d
		} else if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return nil, fmt.Errorf("create temp folder: %w", err)
	}
	var out []string
	for i, at := range frameTimes(durMs, VideoFrames) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name := fmt.Sprintf("v%d_%d.jpg", idx, i)
		_, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: frameArgs(input, at, name), Dir: job.TempDir})
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		p := filepath.Join(job.TempDir, name)
		if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, core.Errorf(core.CodeToolFailed, "Couldn't read frames from %s", filepath.Base(input))
	}
	return out, nil
}

func defaultProbeDuration(ctx context.Context, ffprobe, path string) (int64, error) {
	info, err := media.Probe(ctx, ffprobe, path)
	if err != nil {
		return 0, err
	}
	return info.DurationMs, nil
}
