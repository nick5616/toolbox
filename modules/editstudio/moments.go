package editstudio

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"

	"toolbox/core"
	"toolbox/core/proc"
)

// Footage moments (Phase 9 Part C): the stand-out instants of a video —
// sudden motion, flashes, impacts — found from FFmpeg's per-frame scene
// score on the preview stream and cached as motion.json next to shots.json.

const motionFile = "motion.json"

// Moment is one stand-out instant of a source (source ms).
type Moment struct {
	Ms       int64   `json:"ms"`
	Strength float64 `json:"strength"` // 0..1
	Kind     string  `json:"kind"`     // "cut" (a shot change) | "motion" (a burst of movement or light)
}

// motionCurve is the cached per-frame scene score of a preview stream.
type motionCurve struct {
	FPS    int       `json:"fps"`
	Scores []float64 `json:"scores"` // 0..1 per stream frame
}

var sceneScoreRe = regexp.MustCompile(`lavfi\.scene_score=([0-9.]+)`)

// motionArgs prints every frame's scene score of an Annex-B stream.
func motionArgs(stream string, fps int) []string {
	return []string{
		"-hide_banner", "-nostdin", "-f", "h264", "-framerate", strconv.Itoa(fps), "-i", stream,
		"-vf", "scale=160:-2,select='gte(scene,0)',metadata=print:file=-",
		"-an", "-f", "null", "-",
	}
}

// parseSceneScores reads `metadata=print` output into one score per frame.
func parseSceneScores(lines []string) []float64 {
	out := []float64{}
	for _, l := range lines {
		mt := sceneScoreRe.FindStringSubmatch(l)
		if mt == nil {
			continue
		}
		v, err := strconv.ParseFloat(mt[1], 64)
		if err != nil {
			continue
		}
		out = append(out, math.Max(0, math.Min(1, v)))
	}
	return out
}

// pickMoments finds the stand-out instants of a clip: its shot changes
// (`shots`, source ms) and bursts of movement or light. The scene score is
// smoothed over 7 frames first (CFR conversion duplicates frames, which makes
// the raw score saw-toothed); a burst is a local peak clearly above the typical
// motion of the 2 s around it. The strongest win, 0.6 s apart, about one per
// 1.5 s of footage at most.
func pickMoments(c motionCurve, shots []int64) []Moment {
	n := len(c.Scores)
	if n == 0 || c.FPS <= 0 {
		return []Moment{}
	}
	sm := make([]float64, n)
	for i := range sm {
		lo, hi := max(0, i-3), min(n-1, i+3)
		sum := 0.0
		for j := lo; j <= hi; j++ {
			sum += c.Scores[j]
		}
		sm[i] = sum / float64(hi-lo+1)
	}
	type cand struct {
		ms    int64
		kind  string
		score float64
	}
	var cands []cand
	for _, s := range shots {
		if s > 0 {
			cands = append(cands, cand{s, "cut", 1})
		}
	}
	win := c.FPS * 2
	local := make([]float64, 0, 2*win+1)
	for i := 1; i < n-1; i++ {
		v := sm[i]
		if v < sm[i-1] || v < sm[i+1] || v < 0.05 {
			continue
		}
		local = local[:0]
		for j := max(0, i-win); j <= min(n-1, i+win); j++ {
			local = append(local, sm[j])
		}
		sort.Float64s(local)
		med := math.Max(0.01, local[len(local)/2])
		ratio := v / med
		if ratio >= 1.8 {
			cands = append(cands, cand{int64(math.Round(float64(i) * 1000 / float64(c.FPS))), "motion", math.Min(1, 0.35+(ratio-1)/4)})
		}
	}
	if len(cands) == 0 {
		// Even busy footage has a peak: offer its strongest instant.
		best := 0
		for i := range sm {
			if sm[i] > sm[best] {
				best = i
			}
		}
		if sm[best] >= 0.05 {
			cands = append(cands, cand{int64(math.Round(float64(best) * 1000 / float64(c.FPS))), "motion", 0.5})
		}
	}
	sort.SliceStable(cands, func(a, b int) bool { return cands[a].score > cands[b].score })
	durMs := int64(n) * 1000 / int64(c.FPS)
	budget := max(3, int(durMs/1500))
	kept := []cand{}
	for _, cd := range cands {
		if len(kept) >= budget {
			break
		}
		ok := true
		for _, k := range kept {
			if d := cd.ms - k.ms; d < 600 && d > -600 {
				ok = false
				break
			}
		}
		if ok {
			kept = append(kept, cd)
		}
	}
	sort.Slice(kept, func(a, b int) bool { return kept[a].ms < kept[b].ms })
	out := make([]Moment, 0, len(kept))
	for _, k := range kept {
		out = append(out, Moment{Ms: k.ms, Strength: math.Round(k.score*100) / 100, Kind: k.kind})
	}
	return out
}

// EnsureMotion returns the cached motion curve of a video source, measuring it when missing.
func (m *Module) EnsureMotion(ctx context.Context, path string, fps int) (motionCurve, error) {
	dir, err := m.srcDir(path)
	if err != nil {
		return motionCurve{}, err
	}
	file := filepath.Join(dir, motionFile)
	if b, err := os.ReadFile(file); err == nil {
		var c motionCurve
		if json.Unmarshal(b, &c) == nil && c.FPS > 0 {
			return c, nil
		}
	}
	ffmpeg, err := m.tool(nil, "ffmpeg")
	if err != nil {
		return motionCurve{}, err
	}
	es, err := m.previewStream(ctx, nil, path, fps, nil)
	if err != nil {
		return motionCurve{}, err
	}
	var lines []string
	res, err := runFFmpeg(ctx, proc.Spec{Path: ffmpeg, Args: motionArgs(es.Stream, es.FPS), OnStdout: func(l string) { lines = append(lines, l) }})
	if err != nil {
		if ctx.Err() != nil {
			return motionCurve{}, ctx.Err()
		}
		return motionCurve{}, ffmpegError("measure the motion in this clip", res, err)
	}
	c := motionCurve{FPS: es.FPS, Scores: parseSceneScores(lines)}
	for i, v := range c.Scores {
		c.Scores[i] = math.Round(v*1000) / 1000
	}
	b, _ := json.Marshal(c)
	part := file + ".part"
	if err := os.WriteFile(part, b, 0o644); err == nil {
		if err := os.Rename(part, file); err != nil {
			_ = os.Remove(part)
		}
	}
	touchDir(dir)
	return c, nil
}

// Moments lists the stand-out instants of a video source (source ms), measuring its motion once.
func (s *Service) Moments(path string, fps int) ([]Moment, error) {
	if fps != 60 {
		fps = 30
	}
	c, err := s.m.EnsureMotion(context.Background(), path, fps)
	if err != nil {
		return nil, err
	}
	if len(c.Scores) == 0 {
		return []Moment{}, core.Errorf(core.CodeToolFailed, "Couldn't measure the motion in this clip")
	}
	return pickMoments(c, s.m.ShotsFor(path)), nil
}
