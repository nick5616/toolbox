package compress

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"

	"toolbox/core"
	"toolbox/core/media"
)

// AudioCodec is the codec an audio plan encodes with.
type AudioCodec string

const (
	AudioMP3  AudioCodec = "mp3"
	AudioOpus AudioCodec = "opus"
)

// AudioPlan is what an audio file would be encoded as.
type AudioPlan struct {
	Possible   bool
	Grade      Grade
	Codec      AudioCodec
	Kbps       int
	Mono       bool
	SampleRate int // 0 = unchanged
	Parts      int
	PartMs     int64
}

var mp3Ladder = []int{320, 256, 224, 192, 160, 128, 112, 96, 80, 64, 56, 48, 40, 32}

const (
	opusMinKbps = 6
	opusMaxKbps = 32
)

// Ext is the output file extension.
func (p AudioPlan) Ext() string {
	if p.Codec == AudioOpus {
		return ".ogg"
	}
	return ".mp3"
}

// planAudio plans one audio file for a byte budget, splitting when opts ask
// for it and the single file would sound poor.
func planAudio(durMs, budgetBytes int64, opts Options) AudioPlan {
	single := planAudioSingle(durMs, budgetBytes)
	if opts.IfTooSmall != TooSmallSplit || (single.Possible && atLeastFair(single.Grade)) {
		return single
	}
	var last AudioPlan
	for n := 2; n <= MaxParts; n++ {
		pd := partDur(durMs, n)
		p := planAudioSingle(pd, budgetBytes)
		p.Parts, p.PartMs = n, pd
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

func planAudioSingle(durMs, budgetBytes int64) AudioPlan {
	p := AudioPlan{Parts: 1, PartMs: durMs}
	if durMs <= 0 {
		return p
	}
	raw := float64(budgetBytes) * 8 / (float64(durMs) / 1000) / 1000 * 0.99 // kb/s
	switch {
	case raw >= 32:
		p.Codec, p.Possible = AudioMP3, true
		for _, k := range mp3Ladder {
			if float64(k) <= raw {
				p.Kbps = k
				break
			}
		}
		if p.Kbps < 64 {
			p.Mono, p.SampleRate = true, 22050
		}
	case raw >= opusMinKbps:
		p.Codec, p.Possible = AudioOpus, true
		p.Kbps = min(int(raw), opusMaxKbps)
		p.Mono = p.Kbps < 24
	default:
		return p
	}
	eff := float64(p.Kbps)
	if p.Codec == AudioOpus {
		eff *= 1.6
	}
	switch {
	case eff >= 128:
		p.Grade = GradeGreat
	case eff >= 96:
		p.Grade = GradeGood
	case eff >= 64:
		p.Grade = GradeFair
	default:
		p.Grade = GradePoor
	}
	return p
}

// Summary: "MP3 128 kb/s", "Opus 24 kb/s mono".
func (p AudioPlan) Summary() string {
	if !p.Possible {
		return ""
	}
	name := "MP3"
	if p.Codec == AudioOpus {
		name = "Opus"
	}
	s := fmt.Sprintf("%s %d kb/s", name, p.Kbps)
	if p.Mono && p.Codec == AudioOpus {
		s += " mono"
	}
	return s
}

// Describe is Summary with the number of parts in front when split.
func (p AudioPlan) Describe() string { return partsPrefix(p.Parts) + p.Summary() }

// audioArgs builds the FFmpeg arguments for one audio part at kbps.
func audioArgs(p AudioPlan, kbps int, src string, part partRange, split bool, opts Options, out string) []string {
	a := commonArgs()
	if split {
		a = append(a, "-ss", secs(part.StartMs), "-t", secs(part.DurMs))
	}
	a = append(a, "-i", src, "-vn", "-sn", "-dn", "-map", "0:a:0")
	if p.Codec == AudioOpus {
		a = append(a, "-c:a", "libopus", "-b:a", strconv.Itoa(kbps)+"k", "-vbr", "on")
	} else {
		a = append(a, "-c:a", "libmp3lame", "-b:a", strconv.Itoa(kbps)+"k")
	}
	if p.Mono {
		a = append(a, "-ac", "1")
	}
	if p.SampleRate > 0 {
		a = append(a, "-ar", strconv.Itoa(p.SampleRate))
	}
	if !opts.KeepMetadata {
		a = append(a, "-map_metadata", "-1", "-map_chapters", "-1")
	}
	return append(a, out)
}

// nextAudioKbps is the bitrate for the next retry, or 0 when there is none.
func nextAudioKbps(p AudioPlan, kbps int) int {
	if p.Codec == AudioOpus {
		n := int(math.Floor(float64(kbps) * 0.85))
		if n < opusMinKbps || n >= kbps {
			return 0
		}
		return n
	}
	for _, k := range mp3Ladder {
		if k < kbps {
			return k
		}
	}
	return 0
}

func runAudio(ctx context.Context, job *core.JobContext, in input) (Result, error) {
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
	if len(info.Audio) == 0 {
		return Result{}, core.ValidationError("This file has no sound", nil)
	}
	if info.DurationMs <= 0 {
		return Result{}, core.ValidationError("Can't tell how long this is", nil)
	}
	budget := Budget(in.Limit)
	plan := planAudio(info.DurationMs, budget, in.Opts)
	if !plan.Possible {
		return Result{}, core.Errorf(core.CodeToolFailed, "This is too long to fit under %s", FormatBytes(in.Limit)).
			WithHint("Choose a larger size, or split it into parts")
	}
	ranges := splitRanges(info.DurationMs, plan.Parts)
	res := Result{Plan: plan.Describe(), Grade: plan.Grade, Parts: plan.Parts}
	for i, pr := range ranges {
		from, to := float64(i)/float64(len(ranges)), float64(i+1)/float64(len(ranges))
		out, attempts, err := encodeAudioPart(ctx, job, ffmpeg, in, plan, i, pr, from, to)
		res.Attempts = max(res.Attempts, attempts)
		if err != nil {
			return res, err
		}
		stem := OutputName(in.Path)
		if plan.Parts > 1 {
			stem = PartName(in.Path, i+1, plan.Parts)
		}
		final, err := saveOutput(job, out, stem, plan.Ext())
		if err != nil {
			return res, err
		}
		res.Outputs = append(res.Outputs, final)
	}
	return res, nil
}

func encodeAudioPart(ctx context.Context, job *core.JobContext, ffmpeg string, in input, plan AudioPlan, idx int, pr partRange, from, to float64) (string, int, error) {
	split := plan.Parts > 1
	kbps := plan.Kbps
	hint := "Try a larger size, or split it into parts"
	var last int64
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		out := filepath.Join(job.TempDir, fmt.Sprintf("out-%d-%d%s", idx, attempt, plan.Ext()))
		af, at := attemptSpan(attempt)
		af, at = subRange(from, to, af, at)
		label := "Compressing"
		if split {
			label = fmt.Sprintf("Part %d of %d", idx+1, plan.Parts)
		}
		if err := runFF(ctx, job.Scoped(af, at), ffmpeg, job.TempDir,
			audioArgs(plan, kbps, in.Path, pr, split, in.Opts, out), float64(pr.DurMs)/1000, label); err != nil {
			if plan.Codec == AudioOpus {
				err = mapEncoderError(err, "Opus")
			} else {
				err = mapEncoderError(err, "MP3")
			}
			return "", attempt, err
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
		if kbps = nextAudioKbps(plan, kbps); kbps == 0 {
			return "", attempt + 1, overLimit(last, in.Limit, hint)
		}
	}
	return "", MaxAttempts, overLimit(last, in.Limit, hint)
}

func estimateAudio(ctx context.Context, tool toolFunc, in input) Estimate {
	info, problem := probeFile(ctx, tool, in.Path)
	if problem != "" {
		return Estimate{Problem: problem}
	}
	if len(info.Audio) == 0 {
		return Estimate{Problem: "This file has no sound"}
	}
	return estimateAudioInfo(info, in)
}

// estimateAudioInfo plans the sound of a probed file (also used for a "video"
// without a picture).
func estimateAudioInfo(info media.Info, in input) Estimate {
	if len(info.Audio) == 0 {
		if info.Video != nil {
			return Estimate{Problem: "This file has no sound"}
		}
		return Estimate{Problem: "This file has no video"}
	}
	plan := planAudio(info.DurationMs, Budget(in.Limit), in.Opts)
	e := Estimate{Possible: plan.Possible, Plan: plan.Describe(), Grade: plan.Grade, Parts: plan.Parts}
	switch {
	case !plan.Possible:
		e.Note = "Too long to fit at this size"
	case plan.Parts > 1:
		e.Note = fmt.Sprintf("Split into %d parts, each under %s", plan.Parts, FormatBytes(in.Limit))
	case plan.Grade == GradePoor:
		e.Note = "It will sound rough at this size"
	}
	return e
}
