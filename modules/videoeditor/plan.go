package videoeditor

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"

	"toolbox/core"
	"toolbox/core/viz"
)

// Quick vlog (SPEC.md §B6.3).

const (
	planVideoMs   = 3000
	planPhotoMs   = 2500
	planShortMs   = 3000 // videos up to this get one bar
	planTransMs   = 500
	planFadeOutMs = 1500
)

// planItem is one probed source in the plan.
type planItem struct {
	Path       string
	Kind       string // "video" | "image"
	DurationMs int64
	TakenAt    int64
}

// orderItems sorts by date taken when asked (stable, unknown dates last).
func orderItems(items []planItem, order string) []planItem {
	out := append([]planItem(nil), items...)
	if order == "date-taken" {
		sort.SliceStable(out, func(i, j int) bool {
			a, b := out[i].TakenAt, out[j].TakenAt
			if (a == 0) != (b == 0) {
				return b == 0
			}
			return a < b
		})
	}
	return out
}

// barStarts are the bar starts from 0: the downbeats, or a fixed step from
// the tempo when there are none.
func barStarts(durationMs int64, tempo float64, downbeats []int64) []int64 {
	out := []int64{0}
	for _, d := range downbeats {
		if d > out[len(out)-1] {
			out = append(out, d)
		}
	}
	if len(out) == 1 {
		step := int64(2000)
		if tempo > 0 {
			step = max(int64(4*60000/tempo), 500)
		}
		for t := step; t <= durationMs; t += step {
			out = append(out, t)
		}
	}
	return out
}

// barPos is the time of bar k; past the last known bar it extrapolates with
// the average bar length.
func barPos(bars []int64, k int) int64 {
	last := len(bars) - 1
	if k <= last {
		return bars[k]
	}
	avg := int64(2000)
	if last > 0 {
		avg = max(bars[last]/int64(last), 500)
	}
	return bars[last] + int64(k-last)*avg
}

// nearestBar is the index of the bar start closest to t (searching past the
// last known bar too).
func nearestBar(bars []int64, t int64) int {
	best, bestD := 0, int64(math.MaxInt64)
	for k := 0; ; k++ {
		p := barPos(bars, k)
		d := p - t
		if d < 0 {
			d = -d
		}
		if d < bestD {
			best, bestD = k, d
		}
		if p > t {
			return best
		}
	}
}

// buildPlanDoc turns ordered, usable items into a project (SPEC.md §B6.3).
// bars is empty without beat-cutting; songMs is 0 without music.
func buildPlanDoc(req PlanRequest, items []planItem, bars []int64, songMs int64) (VideoProject, error) {
	n := len(items)
	if n == 0 {
		return VideoProject{}, core.ValidationError("None of these files can go in a video", nil)
	}
	tk := req.Transition
	if tk == "" {
		tk = "cut"
	}
	target := req.TargetMs
	if target == 0 {
		target = songMs
	}
	want := target
	if want > 0 && tk != "cut" {
		want += int64(n-1) * planTransMs // transitions overlap, so the clips must add up to more
	}

	// Raw cumulative boundaries: bars with beats, fixed lengths without.
	cum := make([]int64, n+1)
	b := 0
	for i, it := range items {
		if len(bars) > 1 {
			nb := 2
			if it.Kind == "image" || it.DurationMs <= planShortMs {
				nb = 1
			}
			b += nb
			cum[i+1] = barPos(bars, b)
		} else if it.Kind == "image" {
			cum[i+1] = cum[i] + planPhotoMs
		} else {
			cum[i+1] = cum[i] + planVideoMs
		}
	}
	f := 1.0
	if want > 0 && cum[n] > 0 {
		f = float64(want) / float64(cum[n])
	}
	ends := make([]int64, n+1)
	prevK := 0
	for i := 1; i <= n; i++ {
		s := int64(math.Round(float64(cum[i]) * f))
		if len(bars) > 1 {
			k := max(nearestBar(bars, s), prevK+1)
			prevK = k
			s = barPos(bars, k)
		}
		if i == n && want > 0 && want > ends[i-1] {
			s = want // the last clip ends with the song (or the target), not on a bar
		}
		ends[i] = s
	}

	clips := make([]Clip, 0, n)
	var cur int64
	photo := 0
	for i, it := range items {
		l := ends[i+1] - cur
		c := Clip{
			ID: core.NewID(), Kind: it.Kind, Path: it.Path, Speed: 1, Volume: 1,
			Fit: "fill", FitColor: "#000000", Zoom: 1, Motion: "none", Look: "none",
			Transition: Transition{Kind: "cut", DurationMs: 0},
		}
		if it.Kind == "image" {
			l = max(MinPhotoMs, min(l, MaxPhotoMs))
			c.DurationMs = l
			c.Motion = []string{"in", "out"}[photo%2]
			photo++
		} else {
			l = max(MinClipMs, min(l, it.DurationMs))
			c.InMs = max((it.DurationMs-l)/2, 0)
			c.OutMs = c.InMs + l
		}
		cur += l
		clips = append(clips, c)
	}
	if tk != "cut" {
		for i := 0; i < n-1; i++ {
			d := min(planTransMs, clipLenMs(clips[i])/2, clipLenMs(clips[i+1])/2)
			if d >= minTransitionMs {
				clips[i].Transition = Transition{Kind: tk, DurationMs: d}
			}
		}
	}

	doc := VideoProject{Version: 1, Aspect: req.Aspect, Clips: clips, Titles: []Title{}}
	if req.MusicPath != "" {
		doc.Music = &Music{Path: req.MusicPath, Volume: 1, FadeOutMs: planFadeOutMs, Duck: true}
	}
	if err := validateShape(doc); err != nil {
		return VideoProject{}, err
	}
	return doc, nil
}

// analyzeBars gets the song's bar starts (cached analysis, no stems, no
// words, no mood) and its length.
func (m *Module) analyzeBars(ctx context.Context, job *core.JobContext, song string) ([]int64, int64, error) {
	if m.cfg.Analyzer == nil {
		return nil, 0, core.Errorf(core.CodeInternal, "Beat detection isn't available")
	}
	ref, err := m.cfg.Analyzer.Analyze(ctx, job, song, viz.AnalyzeOptions{Words: viz.WordsNone})
	if err != nil {
		return nil, 0, err
	}
	b, err := os.ReadFile(ref.AudioJSON)
	if err != nil {
		return nil, 0, fmt.Errorf("reading the song analysis: %w", err)
	}
	var a struct {
		DurationMs int64   `json:"durationMs"`
		Tempo      float64 `json:"tempo"`
		Downbeats  []int64 `json:"downbeats"`
	}
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, 0, fmt.Errorf("decoding the song analysis: %w", err)
	}
	return barStarts(a.DurationMs, a.Tempo, a.Downbeats), a.DurationMs, nil
}

// runPlan is the "plan" action.
func (m *Module) runPlan(ctx context.Context, job *core.JobContext, req PlanRequest) error {
	if err := validatePlan(req); err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	job.SetTitle("Quick vlog")

	var items []planItem
	for i, p := range req.Paths {
		job.Progress(0.2*float64(i)/float64(len(req.Paths)), "Reading the clips…")
		ci := probeFile(ctx, ffprobe, p)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		switch {
		case ci.Error != "" || (ci.Kind != "video" && ci.Kind != "image"):
			job.Logf("Skipped %s: %s", filepath.Base(p), orStr(ci.Error, "not a video or photo"))
		case ci.Kind == "video" && ci.DurationMs < MinClipMs:
			job.Logf("Skipped %s: too short", filepath.Base(p))
		default:
			items = append(items, planItem{Path: p, Kind: ci.Kind, DurationMs: ci.DurationMs, TakenAt: ci.TakenAt})
		}
	}
	items = orderItems(items, req.Order)

	var songMs int64
	var bars []int64
	if req.MusicPath != "" {
		if req.BeatCut {
			bars, songMs, err = m.bars(ctx, job.Scoped(0.2, 0.9), req.MusicPath)
			if err != nil {
				return err
			}
		} else {
			ci := probeFile(ctx, ffprobe, req.MusicPath)
			if ci.Error != "" {
				return core.Errorf(core.CodeValidation, "Couldn't read the song").WithHint(ci.Error)
			}
			songMs = ci.DurationMs
		}
	}
	job.Progress(0.95, "Building the timeline…")
	doc, err := buildPlanDoc(req, items, bars, songMs)
	if err != nil {
		return err
	}
	name := "Vlog " + time.Now().Format("2006-01-02")
	info, err := m.docs.Create(ctx, name, doc)
	if err != nil {
		return err
	}
	if err := job.SetResult(PlanResult{ProjectID: info.ID}); err != nil {
		return err
	}
	job.Progress(1, "Done")
	return nil
}

func orStr(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}
