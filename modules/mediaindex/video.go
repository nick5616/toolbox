package mediaindex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/proc"
)

// Video sampling (SPEC.md §3.3).
const (
	maxVideoFrames = 16
	minFrameStepMs = 2000
	dedupeBits     = 6 // a frame within this many dHash bits of the last kept one is dropped
)

// frameSchedule is when to sample a video: count frames at start + k·step.
type frameSchedule struct {
	StartMs, StepMs int64
	Count           int
}

// Times lists the sample times in ms.
func (s frameSchedule) Times() []int64 {
	out := make([]int64, s.Count)
	for i := range out {
		out[i] = s.StartMs + int64(i)*s.StepMs
	}
	return out
}

// videoSchedule takes frames at max(2 s, duration/16) steps (the first half a
// step in, so it isn't a black opening frame), at most 16.
func videoSchedule(durationMs int64) frameSchedule {
	if durationMs <= 0 {
		return frameSchedule{StartMs: 0, StepMs: minFrameStepMs, Count: 1}
	}
	step := max(int64(minFrameStepMs), durationMs/maxVideoFrames)
	start := step / 2
	if start >= durationMs {
		return frameSchedule{StartMs: durationMs / 2, StepMs: step, Count: 1}
	}
	n := int((durationMs - start + step - 1) / step)
	return frameSchedule{StartMs: start, StepMs: step, Count: min(max(n, 1), maxVideoFrames)}
}

// middleSchedule is two frames, the first and the middle (animated WebP).
func middleSchedule(durationMs int64) frameSchedule {
	if durationMs < 2 {
		return frameSchedule{StepMs: 1, Count: 1}
	}
	return frameSchedule{StartMs: 0, StepMs: durationMs / 2, Count: 2}
}

// dedupeHashes returns the indexes to keep: a hash within maxDist bits of the
// previously kept one is dropped.
func dedupeHashes(hashes []imaging.DHash, maxDist int) []int {
	var keep []int
	for i, h := range hashes {
		if len(keep) > 0 && hashes[keep[len(keep)-1]].Distance(h) <= maxDist {
			continue
		}
		keep = append(keep, i)
	}
	return keep
}

// extractFrames runs FFmpeg once in dir and returns the JPEG files it wrote
// (≤ 1600 px long side, upright), in time order. The filter graph is a file
// and the output names are relative, so no Windows path is ever inside a
// filter.
func extractFrames(ctx context.Context, ffmpeg, input, dir string, s frameSchedule) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	stepSec := strconv.FormatFloat(float64(s.StepMs)/1000, 'f', 3, 64)
	// select (the first frame, then each frame a step after the last kept
	// one), not fps=1/step: fps writes nothing when less than half a step
	// is left after the seek (short scene clips).
	graph := "[0:v:0]select='isnan(prev_selected_t)+gte(t-prev_selected_t\\," + stepSec + ")',scale='min(" + strconv.Itoa(ocrLong) + ",iw)':'min(" + strconv.Itoa(ocrLong) + ",ih)':force_original_aspect_ratio=decrease[o]\n"
	if err := os.WriteFile(filepath.Join(dir, "graph.txt"), []byte(graph), 0o644); err != nil {
		return nil, err
	}
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y"}
	if s.StartMs > 0 {
		args = append(args, "-ss", strconv.FormatFloat(float64(s.StartMs)/1000, 'f', 3, 64))
	}
	args = append(args, "-i", input, "-an", "-sn", "-/filter_complex", "graph.txt", "-map", "[o]", "-fps_mode", "vfr",
		"-frames:v", strconv.Itoa(s.Count), "-q:v", "3", "f%03d.jpg")
	var last string
	_, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: args, Dir: dir,
		OnStderr: func(l string) { last = l },
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) {
			return nil, fmt.Errorf("run ffmpeg: %w", err)
		}
		if strings.TrimSpace(last) == "" {
			last = "FFmpeg couldn't read the video"
		}
		return nil, core.Errorf(core.CodeToolFailed, "%s", strings.TrimSpace(last)).WithCause(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "f*.jpg"))
	sort.Strings(files)
	return files, nil
}
