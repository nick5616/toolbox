package editstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"toolbox/core"
	"toolbox/core/proc"
)

// Shot boundaries (SPEC.md §7.4). WP-ES4.

const (
	shotsFile     = "shots.json"
	sceneScore    = 0.3
	minShotGapMs  = 500
	shotsProgress = "Finding cuts"
)

var ptsTimeRe = regexp.MustCompile(`pts_time:\s*([0-9.]+)`)

// shotArgs is the FFmpeg command line that prints scene changes of a stream.
func shotArgs(stream string, fps int) []string {
	return []string{
		"-hide_banner", "-nostdin", "-f", "h264", "-framerate", strconv.Itoa(fps), "-i", stream,
		"-vf", fmt.Sprintf("select='gt(scene,%g)',metadata=print:file=-", sceneScore),
		"-an", "-f", "null", "-",
	}
}

// parseShots reads `metadata=print` output and returns source ms, dropping
// cuts closer than 500 ms to the one before.
func parseShots(lines []string) []int64 {
	out := []int64{}
	for _, l := range lines {
		mt := ptsTimeRe.FindStringSubmatch(l)
		if mt == nil {
			continue
		}
		sec, err := strconv.ParseFloat(mt[1], 64)
		if err != nil {
			continue
		}
		ms := int64(math.Round(sec * 1000))
		if n := len(out); n > 0 && ms-out[n-1] < minShotGapMs {
			continue
		}
		out = append(out, ms)
	}
	return out
}

// EnsureShots finds the shot boundaries (source ms) of a video, cached in shots.json.
func (m *Module) EnsureShots(ctx context.Context, job *core.JobContext, path string, fps int) ([]int64, error) {
	if s := m.ShotsFor(path); s != nil {
		return s, nil
	}
	dir, err := m.srcDir(path)
	if err != nil {
		return nil, err
	}
	ffmpeg, err := m.tool(job, "ffmpeg")
	if err != nil {
		return nil, err
	}
	es, err := m.previewStream(ctx, job, path, fps, nil)
	if err != nil {
		return nil, err
	}
	var lines []string
	res, err := runFFmpeg(ctx, proc.Spec{
		Path: ffmpeg, Args: shotArgs(es.Stream, es.FPS),
		OnStdout: func(l string) { lines = append(lines, l) },
		OnStderr: func(l string) {
			if job != nil {
				job.Log(core.StreamStderr, l)
			}
		},
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ffmpegError("find the cuts in this clip", res, err)
	}
	shots := parseShots(lines)
	b, _ := json.Marshal(shots)
	part := filepath.Join(dir, shotsFile+".part")
	if err := os.WriteFile(part, b, 0o644); err != nil {
		return nil, core.Errorf(core.CodeInternal, "Couldn't save the cuts").WithCause(err)
	}
	if err := os.Rename(part, filepath.Join(dir, shotsFile)); err != nil {
		_ = os.Remove(part)
		return nil, core.Errorf(core.CodeInternal, "Couldn't save the cuts").WithCause(err)
	}
	touchDir(dir)
	return shots, nil
}

// ShotsFor returns cached shots, or nil.
func (m *Module) ShotsFor(path string) []int64 {
	dir, err := m.srcDir(path)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(dir, shotsFile))
	if err != nil {
		return nil
	}
	var shots []int64
	if json.Unmarshal(b, &shots) != nil {
		return nil
	}
	if shots == nil {
		shots = []int64{}
	}
	touchDir(dir)
	return shots
}
