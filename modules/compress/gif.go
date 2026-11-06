package compress

import (
	"context"
	"fmt"
	"image/gif"
	"math"
	"os"
	"path/filepath"

	"toolbox/core"
)

// GIF ladder limits.
const (
	gifMaxEncodes = 6
	gifMinWidth   = 64
	gifMinFPS     = 4
	gifMaxFPS     = 50
)

// gifSettings are the knobs of one GIF encode.
type gifSettings struct{ Width, FPS, Colors int }

func (s gifSettings) plan() string {
	return fmt.Sprintf("GIF %d px · %d fps · %d colours", s.Width, s.FPS, s.Colors)
}

// gifSource is what we know about the source GIF.
type gifSource struct {
	Width, Height int
	Frames        int
	DurationSec   float64
	FPS           float64
}

// gifDelayCS is a frame delay in centiseconds as browsers play it (0 and 1
// are treated as 10 cs).
func gifDelayCS(d int) int {
	if d <= 1 {
		return 10
	}
	return d
}

// readGIF reads the source facts of an animated (or single-frame) GIF.
func readGIF(path string) (gifSource, error) {
	f, err := os.Open(path)
	if err != nil {
		return gifSource{}, fmt.Errorf("open gif: %w", err)
	}
	defer f.Close()
	g, err := gif.DecodeAll(f)
	if err != nil {
		return gifSource{}, core.Errorf(core.CodeToolFailed, "Can't read this GIF").WithCause(err)
	}
	s := gifSource{Width: g.Config.Width, Height: g.Config.Height, Frames: len(g.Image)}
	cs := 0
	for _, d := range g.Delay {
		cs += gifDelayCS(d)
	}
	s.DurationSec = float64(cs) / 100
	if s.DurationSec > 0 {
		s.FPS = float64(s.Frames) / s.DurationSec
	}
	return s, nil
}

// gifReduce applies a size ratio f (against the current w x fps) split evenly
// between frame rate and linear size, within floors and the source's limits.
func gifReduce(w, fps int, f float64, srcW int, srcFPS float64) (int, int) {
	maxFPS := max(1, min(int(math.Round(srcFPS)), gifMaxFPS))
	minFPS := min(gifMinFPS, maxFPS)
	a := math.Cbrt(f)
	nfps := min(max(int(math.Round(float64(fps)*a)), minFPS), maxFPS)
	af := float64(nfps) / float64(fps)
	s := math.Sqrt(f / af)
	minW := min(gifMinWidth, srcW)
	nw := min(max(int(math.Round(float64(w)*s)), minW), srcW)
	return nw &^ 1, nfps
}

// gifInitial is the first guess: size is taken to be proportional to
// width² x fps, so the plan follows from the source size alone.
func gifInitial(src gifSource, srcSize, budget int64) gifSettings {
	fps := max(1, min(int(math.Round(src.FPS)), gifMaxFPS))
	f := float64(budget) / float64(srcSize) * 0.9
	w, nfps := gifReduce(src.Width, fps, f, src.Width, src.FPS)
	return gifSettings{Width: w, FPS: nfps, Colors: 256}
}

// gifNext is the next try after cur produced size bytes (attempt is the
// 0-based index of the next encode). changed is false when nothing can move.
func gifNext(cur gifSettings, size, budget int64, src gifSource, attempt int) (gifSettings, bool) {
	f := float64(budget) * 0.95 / float64(size)
	next := cur
	next.Width, next.FPS = gifReduce(cur.Width, cur.FPS, f, src.Width, src.FPS)
	if f < 1 {
		switch {
		case attempt >= 4:
			next.Colors = 64
		case attempt >= 2:
			next.Colors = 128
		}
		next.Colors = min(next.Colors, cur.Colors)
	}
	return next, next != cur
}

// gifGrade grades by the linear scale against the source.
func gifGrade(scale float64) Grade {
	switch {
	case scale >= 0.8:
		return GradeGreat
	case scale >= 0.6:
		return GradeGood
	case scale >= 0.4:
		return GradeFair
	}
	return GradePoor
}

func gifFilter(s gifSettings) string {
	return fmt.Sprintf("fps=%d,scale=w='min(%d,iw)':h=-2:flags=lanczos", s.FPS, s.Width)
}

// encodeGIF draws src at s into out (names relative to dir).
func encodeGIF(ctx context.Context, job *core.JobContext, ffmpeg, dir, src, out string, s gifSettings, dur float64) error {
	const pal = "gif-palette.png"
	args := append(commonArgs(), "-i", src, "-an", "-vf",
		fmt.Sprintf("%s,palettegen=max_colors=%d:stats_mode=diff", gifFilter(s), s.Colors), "-update", "1", pal)
	if err := runFF(ctx, job.Scoped(0, 0.5), ffmpeg, dir, args, dur, "Colours"); err != nil {
		return err
	}
	args = append(commonArgs(), "-i", src, "-i", pal, "-an", "-filter_complex",
		"[0:v:0]"+gifFilter(s)+"[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[o]",
		"-map", "[o]", "-loop", "0", out)
	return runFF(ctx, job.Scoped(0.5, 1), ffmpeg, dir, args, dur, "Drawing")
}

// runGIF shrinks an animated GIF with a (size, fps, colours) ladder; a
// single-frame GIF is just a photo.
func runGIF(ctx context.Context, job *core.JobContext, in input) (Result, error) {
	src, err := readGIF(in.Path)
	if err != nil {
		return Result{}, err
	}
	if src.Frames <= 1 {
		return runImage(ctx, job, in)
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return Result{}, err
	}
	budget := Budget(in.Limit)
	cur := gifInitial(src, in.Size, budget)
	seen := map[gifSettings]bool{}
	var (
		bestPath, bestPlan string
		bestSize           int64
		bestSet            gifSettings
		smallest           int64 = math.MaxInt64
		attempts           int
	)
	for attempt := 0; attempt < gifMaxEncodes; attempt++ {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		seen[cur] = true
		name := fmt.Sprintf("gif-%d.gif", attempt)
		sub := job.Scoped(float64(attempt)/gifMaxEncodes, float64(attempt+1)/gifMaxEncodes)
		job.Progress(float64(attempt)/gifMaxEncodes, cur.plan())
		if err := encodeGIF(ctx, sub, ffmpeg, job.TempDir, in.Path, name, cur, src.DurationSec); err != nil {
			return Result{}, err
		}
		attempts++
		size, err := fileSize(filepath.Join(job.TempDir, name))
		if err != nil {
			return Result{}, err
		}
		smallest = min(smallest, size)
		if size <= budget && size > bestSize {
			bestPath, bestSize, bestSet, bestPlan = filepath.Join(job.TempDir, name), size, cur, cur.plan()
		}
		if size <= budget && size*100 >= budget*75 {
			break // fits with little room to spare
		}
		next, changed := gifNext(cur, size, budget, src, attempt+1)
		if !changed || seen[next] {
			break
		}
		cur = next
	}
	if bestPath == "" {
		return Result{}, overLimit(smallest, in.Limit, "This GIF has too many frames to get that small")
	}
	out, err := saveOutput(job, bestPath, OutputName(in.Path), ".gif")
	if err != nil {
		return Result{}, err
	}
	return Result{Outputs: []string{out}, Plan: bestPlan, Grade: gifGrade(float64(bestSet.Width) / float64(src.Width)), Attempts: attempts}, nil
}

// estimateGIF predicts the first plan from the frame count and size.
func estimateGIF(ctx context.Context, tool toolFunc, in input) Estimate {
	src, err := readGIF(in.Path)
	if err != nil {
		return Estimate{Problem: problemText(err)}
	}
	if src.Frames <= 1 {
		return estimateImage(ctx, tool, in)
	}
	s := gifInitial(src, in.Size, Budget(in.Limit))
	return Estimate{
		Possible: true, Plan: s.plan(), Grade: gifGrade(float64(s.Width) / float64(src.Width)),
		Note: "GIFs are re-drawn until they fit",
	}
}
