package compress

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"

	"toolbox/core"
	"toolbox/core/media"
)

// VideoFacts is what the planner needs to know about a video.
type VideoFacts struct {
	DurationMs    int64
	Width, Height int // display size (rotation applied)
	FPS           float64
	HasAudio      bool
	AudioChannels int
}

// VideoPlan is what a video would be encoded as.
type VideoPlan struct {
	Possible      bool
	Grade         Grade
	Codec         VideoCodec
	SrcWidth      int
	SrcHeight     int
	SrcFPS        float64
	Width, Height int     // output size (even)
	FPS           float64 // output frame rate
	LowerFPS      bool    // an fps filter is needed
	VideoKbps     int
	AudioKbps     int // 0 = no audio
	AudioChannels int
	Bpp           float64 // bits per pixel-frame, codec-adjusted
	Parts         int     // 1 = a single file
	PartMs        int64   // the longest part's duration
}

const (
	containerOverhead = 0.015
	minVideoKbps      = 30
	bppEnough         = 0.07
	h265Gain          = 1.4
)

var (
	videoShortSides = []int{2160, 1440, 1080, 720, 540, 480, 360, 240, 144}
)

// planVideo plans one file for a byte budget, splitting when opts ask for it
// and the single file would look poor.
func planVideo(f VideoFacts, budgetBytes int64, opts Options) VideoPlan {
	single := planVideoSingle(f, budgetBytes, opts)
	if opts.IfTooSmall != TooSmallSplit || (single.Possible && atLeastFair(single.Grade)) {
		return single
	}
	var last VideoPlan
	for n := 2; n <= MaxParts; n++ {
		pf := f
		pf.DurationMs = partDur(f.DurationMs, n)
		p := planVideoSingle(pf, budgetBytes, opts)
		p.Parts, p.PartMs = n, pf.DurationMs
		last = p
		if p.Possible && atLeastFair(p.Grade) {
			return p
		}
	}
	if last.Possible {
		return last
	}
	return single
}

// planVideoSingle plans one file in one piece.
func planVideoSingle(f VideoFacts, budgetBytes int64, opts Options) VideoPlan {
	p := VideoPlan{Codec: opts.VideoCodec, SrcWidth: f.Width, SrcHeight: f.Height, SrcFPS: f.FPS, Parts: 1, PartMs: f.DurationMs}
	if f.DurationMs <= 0 || f.Width <= 0 || f.Height <= 0 {
		return p
	}
	sec := float64(f.DurationMs) / 1000
	total := float64(budgetBytes) * (1 - containerOverhead) * 8 / sec / 1000 // kb/s

	audio, ch := 0, 0
	if opts.KeepAudio && f.HasAudio {
		switch {
		case total > 2000:
			audio = 160
		case total > 800:
			audio = 128
		case total > 300:
			audio = 96
		case total > 150:
			audio = 64
		default:
			audio = 48
		}
		ch = 2
		if f.AudioChannels == 1 || audio == 48 {
			ch = 1
		}
		if total-float64(audio) < minVideoKbps {
			audio = min(audio, max(24, int(total)-minVideoKbps))
		}
	}
	vk := total - float64(audio)
	if vk < minVideoKbps {
		return p
	}
	p.AudioKbps, p.AudioChannels, p.VideoKbps = audio, ch, int(vk)

	gain := 1.0
	if opts.VideoCodec == CodecH265 {
		gain = h265Gain
	}
	cands := videoCandidates(f, opts)
	pick := -1
	for i := range cands {
		c := &cands[i]
		c.bpp = vk * 1000 / (float64(c.w*c.h) * c.fps) * gain
		if pick < 0 && c.bpp >= bppEnough {
			pick = i
		}
	}
	if pick < 0 {
		pick = len(cands) - 1
	}
	c := cands[pick]
	p.Width, p.Height, p.FPS, p.Bpp = c.w, c.h, c.fps, c.bpp
	srcFPS := f.FPS
	if srcFPS <= 0 {
		srcFPS = 30
	}
	p.LowerFPS = c.fps < srcFPS-0.5
	p.Possible = true
	switch {
	case p.Bpp >= 0.10:
		p.Grade = GradeGreat
	case p.Bpp >= 0.06:
		p.Grade = GradeGood
	case p.Bpp >= 0.035:
		p.Grade = GradeFair
	default:
		p.Grade = GradePoor
	}
	// A frame this small looks poor whatever its bitrate (bpp alone would call
	// a 144p picture "great"): scaled below 360p is poor, below 480p at most
	// fair. A source that is small to begin with isn't penalised.
	switch s := min(p.Width, p.Height); {
	case s >= min(f.Width, f.Height):
	case s < 360:
		p.Grade = GradePoor
	case s < 480 && gradeRank(p.Grade) > 1:
		p.Grade = GradeFair
	}
	// Choppy motion caps the grade too: under 24 fps from a smoother source.
	if p.FPS < 23.5 && srcFPS >= 23.5 && gradeRank(p.Grade) > 1 {
		p.Grade = GradeFair
	}
	return p
}

type videoCand struct {
	w, h int
	fps  float64
	bpp  float64
}

func even(n int) int { return n &^ 1 }

// videoCandidates lists (size, fps) in preference order. Motion matters more
// than pixels for most clips, so frame rate is kept smooth while the picture
// shrinks: at 720p and above each size is tried at the source rate (≤ 60) and
// then 30; from 540p to 360p at up to 30; below 360p at up to 24; 15 fps only
// as the last resort at 240p and 144p.
func videoCandidates(f VideoFacts, opts Options) []videoCand {
	short, long := min(f.Width, f.Height), max(f.Width, f.Height)
	ceiling := short
	if opts.MaxHeight > 0 {
		ceiling = min(ceiling, opts.MaxHeight)
	}
	var sides []int
	if ceiling == short && !slices.Contains(videoShortSides, short) && short > 144 && short < videoShortSides[0] {
		sides = append(sides, short)
	}
	for _, s := range videoShortSides {
		if s <= ceiling {
			sides = append(sides, s)
		}
	}
	if len(sides) == 0 {
		sides = []int{ceiling}
	}
	dims := func(side int) (int, int) {
		var w, h int
		if side >= short {
			w, h = f.Width, f.Height
		} else {
			k := float64(side) / float64(short)
			l := int(math.Round(float64(long) * k))
			if f.Width >= f.Height {
				w, h = l, side
			} else {
				w, h = side, l
			}
		}
		return max(even(w), 2), max(even(h), 2)
	}

	top := f.FPS
	if top <= 0 {
		top = 30
	}
	top = min(top, 60)
	var out []videoCand
	add := func(side int, fps float64) {
		w, h := dims(side)
		fps = min(fps, top)
		for _, c := range out {
			if c.w == w && c.h == h && math.Abs(c.fps-fps) < 0.5 {
				return
			}
		}
		out = append(out, videoCand{w: w, h: h, fps: fps})
	}
	for _, s := range sides {
		switch {
		case s >= 720:
			add(s, top)
			add(s, 30)
		case s >= 360:
			add(s, 30)
		default:
			add(s, 24)
		}
	}
	for _, s := range sides {
		if s <= 240 {
			add(s, 15)
		}
	}
	return out
}

func codecLabel(c VideoCodec) string {
	if c == CodecH265 {
		return "H.265"
	}
	return "H.264"
}

// Summary describes the plan: "1080p → 720p · 30 fps · H.264 1.4 Mb/s · AAC 96 kb/s".
func (p VideoPlan) Summary() string {
	if !p.Possible {
		return ""
	}
	size := fmt.Sprintf("%dp", min(p.Width, p.Height))
	if src := min(p.SrcWidth, p.SrcHeight); src != min(p.Width, p.Height) {
		size = fmt.Sprintf("%dp → %s", src, size)
	}
	fps := strconv.FormatFloat(math.Round(p.FPS*100)/100, 'f', -1, 64)
	s := fmt.Sprintf("%s · %s fps · %s %s", size, fps, codecLabel(p.Codec), formatKbps(p.VideoKbps))
	if p.AudioKbps > 0 {
		s += fmt.Sprintf(" · AAC %d kb/s", p.AudioKbps)
		if p.AudioChannels == 1 {
			s += " mono"
		}
	}
	return s
}

// Describe is Summary with the number of parts in front when split.
func (p VideoPlan) Describe() string { return partsPrefix(p.Parts) + p.Summary() }

// videoFacts builds VideoFacts from a probe.
func videoFacts(info media.Info) VideoFacts {
	f := VideoFacts{DurationMs: info.DurationMs, HasAudio: len(info.Audio) > 0}
	if info.Video != nil {
		f.Width, f.Height, f.FPS = info.Video.Width, info.Video.Height, info.Video.FPS
	}
	if f.HasAudio {
		f.AudioChannels = info.Audio[0].Channels
	}
	return f
}

// videoArgs builds one FFmpeg pass (1 or 2) of the two-pass encode. tag
// separates the pass logs of parts and attempts in the working directory.
func videoArgs(pass int, tag string, p VideoPlan, kbps int, src string, part partRange, split bool, opts Options, out string) []string {
	a := commonArgs()
	if split {
		a = append(a, "-ss", secs(part.StartMs), "-t", secs(part.DurMs))
	}
	a = append(a, "-i", src, "-map", "0:v:0")
	withAudio := p.AudioKbps > 0 && pass == 2
	if withAudio {
		a = append(a, "-map", "0:a:0?")
	}
	a = append(a, "-sn", "-dn")
	vf := fmt.Sprintf("scale=%d:%d:flags=lanczos,setsar=1", p.Width, p.Height)
	if p.LowerFPS {
		vf += ",fps=" + strconv.FormatFloat(p.FPS, 'f', -1, 64)
	}
	a = append(a, "-vf", vf)
	enc := "libx264"
	if p.Codec == CodecH265 {
		enc = "libx265"
	}
	a = append(a, "-c:v", enc,
		"-b:v", fmt.Sprintf("%dk", kbps),
		"-maxrate", fmt.Sprintf("%dk", kbps*3/2),
		"-bufsize", fmt.Sprintf("%dk", kbps*2),
		"-preset", "medium", "-pix_fmt", "yuv420p")
	if p.Codec == CodecH265 {
		a = append(a, "-tag:v", "hvc1", "-x265-params", fmt.Sprintf("pass=%d:stats=x265-%s.log:log-level=error", pass, tag))
	} else {
		a = append(a, "-pass", strconv.Itoa(pass), "-passlogfile", "pass-"+tag)
	}
	if pass == 1 {
		return append(a, "-an", "-f", "null", "-")
	}
	if withAudio {
		a = append(a, "-c:a", "aac", "-b:a", fmt.Sprintf("%dk", p.AudioKbps))
		if p.AudioChannels == 1 {
			a = append(a, "-ac", "1")
		}
	} else {
		a = append(a, "-an")
	}
	if !opts.KeepMetadata {
		a = append(a, "-map_metadata", "-1", "-map_chapters", "-1")
	}
	return append(a, "-movflags", "+faststart", out)
}

func secs(ms int64) string { return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64) }

func runVideo(ctx context.Context, job *core.JobContext, in input) (Result, error) {
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return Result{}, err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return Result{}, err
	}
	info, err := media.Probe(ctx, ffprobe, in.Path)
	if err != nil {
		return Result{}, err
	}
	if info.Video == nil {
		return runAudio(ctx, job, in)
	}
	if info.DurationMs <= 0 {
		return Result{}, core.ValidationError("Can't tell how long this video is", nil)
	}
	facts := videoFacts(info)
	budget := Budget(in.Limit)
	plan := planVideo(facts, budget, in.Opts)
	if !plan.Possible {
		return Result{}, core.Errorf(core.CodeToolFailed, "This video is too long to fit under %s", FormatBytes(in.Limit)).
			WithHint("Choose a larger size, or split it into parts")
	}
	ranges := splitRanges(facts.DurationMs, plan.Parts)
	res := Result{Plan: plan.Describe(), Grade: plan.Grade, Parts: plan.Parts}
	for i, pr := range ranges {
		from, to := float64(i)/float64(len(ranges)), float64(i+1)/float64(len(ranges))
		out, attempts, err := encodeVideoPart(ctx, job, ffmpeg, in, plan, i, pr, from, to, budget)
		res.Attempts = max(res.Attempts, attempts)
		if err != nil {
			return res, err
		}
		stem := OutputName(in.Path)
		if plan.Parts > 1 {
			stem = PartName(in.Path, i+1, plan.Parts)
		}
		final, err := saveOutput(job, out, stem, ".mp4")
		if err != nil {
			return res, err
		}
		res.Outputs = append(res.Outputs, final)
	}
	return res, nil
}

// encodeVideoPart encodes one part (or the whole file), retrying with a lower
// bitrate while the result is over the limit. It returns the temp file and the
// number of encodes done.
func encodeVideoPart(ctx context.Context, job *core.JobContext, ffmpeg string, in input, plan VideoPlan, idx int, pr partRange, from, to float64, budget int64) (string, int, error) {
	split := plan.Parts > 1
	secsOut := float64(pr.DurMs) / 1000
	kbps := plan.VideoKbps
	audioBytes := int64(plan.AudioKbps) * 1000 / 8 * pr.DurMs / 1000
	hint := "Try a larger size, or split it into parts"
	var last int64
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		tag := fmt.Sprintf("%d-%d", idx, attempt)
		out := filepath.Join(job.TempDir, fmt.Sprintf("out-%s.mp4", tag))
		af, at := attemptSpan(attempt)
		af, at = subRange(from, to, af, at)
		label := "Compressing"
		if split {
			label = fmt.Sprintf("Part %d of %d", idx+1, plan.Parts)
		}
		p1a, p1b := subRange(af, at, 0, 0.35)
		p2a, p2b := subRange(af, at, 0.35, 1)
		name := codecLabel(plan.Codec)
		if err := runFF(ctx, job.Scoped(p1a, p1b), ffmpeg, job.TempDir,
			videoArgs(1, tag, plan, kbps, in.Path, pr, split, in.Opts, out), secsOut, label+" · analysing"); err != nil {
			return "", attempt, mapEncoderError(err, name)
		}
		if err := runFF(ctx, job.Scoped(p2a, p2b), ffmpeg, job.TempDir,
			videoArgs(2, tag, plan, kbps, in.Path, pr, split, in.Opts, out), secsOut, label+" · encoding"); err != nil {
			return "", attempt, mapEncoderError(err, name)
		}
		n, err := fileSize(out)
		if err != nil {
			return "", attempt + 1, err
		}
		if n <= in.Limit {
			return out, attempt + 1, nil
		}
		last = n
		os.Remove(out)
		kbps = retryKbps(kbps, n, budget, audioBytes)
		if kbps < minVideoKbps {
			return "", attempt + 1, overLimit(last, in.Limit, hint)
		}
	}
	return "", MaxAttempts, overLimit(last, in.Limit, hint)
}

// retryKbps scales the video bitrate so the file lands at the budget.
func retryKbps(kbps int, actual, budget, audioBytes int64) int {
	vActual, vBudget := float64(actual-audioBytes), float64(budget-audioBytes)
	ratio := 0.9
	if vActual > 0 && vBudget > 0 {
		ratio = min(vBudget/vActual*0.98, 0.97)
	}
	return int(float64(kbps) * ratio)
}

func estimateVideo(ctx context.Context, tool toolFunc, in input) Estimate {
	info, problem := probeFile(ctx, tool, in.Path)
	if problem != "" {
		return Estimate{Problem: problem}
	}
	if info.Video == nil {
		return estimateAudioInfo(info, in)
	}
	plan := planVideo(videoFacts(info), Budget(in.Limit), in.Opts)
	e := Estimate{Possible: plan.Possible, Plan: plan.Describe(), Grade: plan.Grade, Parts: plan.Parts}
	switch {
	case !plan.Possible:
		e.Note = "Too long to fit at this size"
	case plan.Parts > 1:
		e.Note = fmt.Sprintf("Split into %d parts, each under %s", plan.Parts, FormatBytes(in.Limit))
	case plan.Grade == GradePoor:
		e.Note = "It will look rough at this size"
	}
	return e
}
