package scenes

import (
	"bufio"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// frameScore is the scene-change score of one video frame.
type frameScore struct {
	ms    int64
	score float64
}

// parseScores reads the file FFmpeg's metadata=print filter writes for
// select='gte(scene,0)': a "frame:… pts_time:12.345" line followed by
// "lavfi.scene_score=0.512" for every frame. Lines it doesn't know are ignored.
func parseScores(text string) []frameScore {
	var (
		out  []frameScore
		cur  int64
		have bool
	)
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if i := strings.Index(line, "pts_time:"); i >= 0 {
			rest := line[i+len("pts_time:"):]
			if j := strings.IndexAny(rest, " \t"); j >= 0 {
				rest = rest[:j]
			}
			if v, err := strconv.ParseFloat(rest, 64); err == nil && !math.IsNaN(v) {
				cur, have = int64(math.Round(v*1000)), true
			} else {
				have = false
			}
			continue
		}
		if v, ok := strings.CutPrefix(line, "lavfi.scene_score="); ok && have {
			if s, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && !math.IsNaN(s) {
				out = append(out, frameScore{ms: cur, score: s})
			}
			have = false
		}
	}
	return out
}

// buildScenes turns frame scores into scenes covering [startMs, durationMs]:
// a cut is a frame scoring above threshold; scenes shorter than minMs merge
// into the one before (the first merges into the one after). Motion is the
// mean score of the frames inside a scene, not counting its opening cut.
func buildScenes(frames []frameScore, threshold float64, minMs, startMs, durationMs int64) []Scene {
	if durationMs <= startMs {
		return []Scene{}
	}
	sort.SliceStable(frames, func(i, j int) bool { return frames[i].ms < frames[j].ms })
	type seg struct {
		start, end int64
		sum        float64
		n          int
	}
	segs := []seg{{start: startMs}}
	for _, f := range frames {
		if f.ms <= startMs || f.ms >= durationMs {
			continue // the first frame is never a cut
		}
		if f.score > threshold {
			segs[len(segs)-1].end = f.ms
			segs = append(segs, seg{start: f.ms})
			continue
		}
		s := &segs[len(segs)-1]
		s.sum += f.score
		s.n++
	}
	segs[len(segs)-1].end = durationMs

	for i := 0; i < len(segs) && len(segs) > 1; {
		if segs[i].end-segs[i].start >= minMs {
			i++
			continue
		}
		if i > 0 {
			p := &segs[i-1]
			p.end = segs[i].end
			p.sum += segs[i].sum
			p.n += segs[i].n
			segs = append(segs[:i], segs[i+1:]...)
		} else {
			nx := &segs[1]
			nx.start = segs[0].start
			nx.sum += segs[0].sum
			nx.n += segs[0].n
			segs = segs[1:]
		}
	}
	out := make([]Scene, len(segs))
	for i, s := range segs {
		m := 0.0
		if s.n > 0 {
			m = s.sum / float64(s.n)
		}
		out[i] = Scene{N: i + 1, StartMs: s.start, EndMs: s.end, Motion: m}
	}
	return out
}

// keepScenes applies Keep: the n longest or most active scenes, back in time order.
func keepScenes(all []Scene, keep Keep, n int) []Scene {
	if keep == KeepAll || keep == "" || n >= len(all) {
		return append([]Scene{}, all...)
	}
	idx := make([]int, len(all))
	for i := range idx {
		idx[i] = i
	}
	less := func(a, b Scene) bool { return a.EndMs-a.StartMs > b.EndMs-b.StartMs }
	if keep == KeepActive {
		less = func(a, b Scene) bool { return a.Motion > b.Motion }
	}
	sort.SliceStable(idx, func(i, j int) bool { return less(all[idx[i]], all[idx[j]]) })
	idx = idx[:max(n, 0)]
	sort.Ints(idx)
	out := make([]Scene, 0, len(idx))
	for _, i := range idx {
		out = append(out, all[i])
	}
	return out
}

// onKeyframe reports whether ms lands within tolMs of a keyframe (keyframes
// ascending, in the same time base).
func onKeyframe(keyframes []int64, ms, tolMs int64) bool {
	i := sort.Search(len(keyframes), func(i int) bool { return keyframes[i] >= ms })
	if i < len(keyframes) && keyframes[i]-ms <= tolMs {
		return true
	}
	return i > 0 && ms-keyframes[i-1] <= tolMs
}

// sceneName names a scene's file: "<stem> (scene 003)".
func sceneName(stem string, n int) string {
	return fmt.Sprintf("%s (scene %03d)", stem, n)
}
