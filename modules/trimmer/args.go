package trimmer

import (
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"strings"
)

// Constants from SPEC.md §4.
const (
	minSegmentMs   = 100
	maxSegments    = 50
	audioBps       = 192000.0 // AAC bitrate used for the size maths
	minVideoKbps   = 150
	sizeSafety     = 0.97
	shiftNoticeMs  = 500
	x264Preset     = "medium"
	x264CRF        = "18"
	defaultAudioBR = "192k"
)

// secs formats ms as ffmpeg seconds.
func secs(ms int64) string {
	return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64)
}

// totalMs is the sum of the segment lengths.
func totalMs(segs []Segment) int64 {
	var t int64
	for _, s := range segs {
		t += s.EndMs - s.StartMs
	}
	return t
}

// fastExt is the output extension for a stream-copy cut of input ext.
func fastExt(ext string) string {
	ext = strings.ToLower(ext)
	switch ext {
	case ".ts", ".mts", ".m2ts":
		return ".ts"
	}
	return ext
}

// fastSegmentArgs cuts [startMs, endMs] of in to out without re-encoding.
// commonArgs go before these.
func fastSegmentArgs(in, out string, startMs, endMs int64, noAudio bool) []string {
	a := []string{"-ss", secs(startMs), "-to", secs(endMs), "-i", in,
		"-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-map_metadata", "0"}
	if noAudio {
		a = append(a, "-an")
	}
	return append(a, out)
}

// fastConcatArgs joins a concat-demuxer list into out.
func fastConcatArgs(list, out string) []string {
	return []string{"-f", "concat", "-safe", "0", "-i", list, "-map", "0", "-c", "copy", "-map_metadata", "0", out}
}

// concatList renders the concat demuxer's list file.
func concatList(paths []string) string {
	var b strings.Builder
	for _, p := range paths {
		b.WriteString("file '" + strings.ReplaceAll(filepath.ToSlash(p), "'", `'\''`) + "'\n")
	}
	return b.String()
}

// cropRect is a crop window in display pixels.
type cropRect struct{ W, H, X, Y int }

func (c cropRect) filter() string { return fmt.Sprintf("crop=%d:%d:%d:%d", c.W, c.H, c.X, c.Y) }

func even(v int) int { return v &^ 1 }

func clampInt(v, lo, hi int) int { return max(lo, min(v, hi)) }

// aspectRatio returns w/h for an Aspect, ok=false for "keep".
func aspectRatio(a Aspect) (float64, bool) {
	switch a {
	case AspectPortrait:
		return 9.0 / 16, true
	case AspectSquare:
		return 1, true
	case AspectFourFive:
		return 4.0 / 5, true
	case AspectWide:
		return 16.0 / 9, true
	}
	return 0, false
}

// cropFor computes the crop for a w×h display-size source. nil means the
// source already has (about) the target ratio, or aspect is "keep".
func cropFor(w, h int, a Aspect, cx, cy float64) *cropRect {
	ratio, ok := aspectRatio(a)
	if !ok || w <= 0 || h <= 0 {
		return nil
	}
	src := float64(w) / float64(h)
	switch {
	case math.Abs(src-ratio) < 0.001:
		return nil
	case ratio < src: // narrower target: keep full height
		cw := min(even(int(math.Round(float64(h)*ratio))), even(w))
		x := clampInt(int(math.Round(cx*float64(w)-float64(cw)/2)), 0, w-cw)
		return &cropRect{W: cw, H: even(h), X: even(x)}
	default: // wider target: keep full width
		ch := min(even(int(math.Round(float64(w)/ratio))), even(h))
		y := clampInt(int(math.Round(cy*float64(h)-float64(ch)/2)), 0, h-ch)
		return &cropRect{W: even(w), H: ch, Y: even(y)}
	}
}

// outputHeight is the frame height after crop and scale.
func outputHeight(srcW, srcH int, o Options) int {
	h := srcH
	if c := cropFor(srcW, srcH, o.Aspect, o.CropX, o.CropY); c != nil {
		h = c.H
	}
	if o.MaxHeight > 0 && h > o.MaxHeight {
		h = o.MaxHeight
	}
	return h
}

// videoFilter is the post-concat chain: crop, then scale down to MaxHeight.
// It is "" when nothing applies.
func videoFilter(srcW, srcH int, o Options) string {
	var parts []string
	h := srcH
	if c := cropFor(srcW, srcH, o.Aspect, o.CropX, o.CropY); c != nil {
		parts = append(parts, c.filter())
		h = c.H
	}
	if o.MaxHeight > 0 && h > o.MaxHeight {
		parts = append(parts, fmt.Sprintf("scale=-2:%d", o.MaxHeight))
	}
	return strings.Join(parts, ",")
}

// buildGraph builds the precise-mode filter graph: per-segment trim +
// setpts, concat, then the optional post chain vf on the video. It returns
// the graph and the labels to -map ("" when that kind is absent).
func buildGraph(segs []Segment, hasV, hasA bool, vf string) (graph, vLabel, aLabel string) {
	var parts []string
	var cat strings.Builder
	for i, s := range segs {
		st, en := secs(s.StartMs), secs(s.EndMs)
		if hasV {
			parts = append(parts, fmt.Sprintf("[0:v:0]trim=start=%s:end=%s,setpts=PTS-STARTPTS[v%d]", st, en, i))
			fmt.Fprintf(&cat, "[v%d]", i)
		}
		if hasA {
			parts = append(parts, fmt.Sprintf("[0:a:0]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS[a%d]", st, en, i))
			fmt.Fprintf(&cat, "[a%d]", i)
		}
	}
	v, a := 0, 0
	var outs string
	if hasV {
		v = 1
		outs += "[cv]"
		vLabel = "[cv]"
	}
	if hasA {
		a = 1
		outs += "[ca]"
		aLabel = "[ca]"
	}
	parts = append(parts, fmt.Sprintf("%sconcat=n=%d:v=%d:a=%d%s", cat.String(), len(segs), v, a, outs))
	if hasV && vf != "" {
		parts = append(parts, "[cv]"+vf+"[vout]")
		vLabel = "[vout]"
	}
	return strings.Join(parts, ";"), vLabel, aLabel
}

// videoBitrateKbps is the x264 target (kbit/s) for a file of maxMB holding
// durSec seconds with audioRate bit/s of audio. It can be <= 0.
func videoBitrateKbps(maxMB int, audioRate, durSec float64) float64 {
	if durSec <= 0 {
		return 0
	}
	total := float64(maxMB) * 8 * 1024 * 1024 * sizeSafety
	return (total - audioRate*durSec) / durSec / 1000
}

// audioFamily maps an input extension to the precise re-encode: output
// extension plus codec args.
func audioFamily(ext string) (string, []string) {
	switch strings.ToLower(ext) {
	case ".mp3":
		return ".mp3", []string{"-c:a", "libmp3lame", "-q:a", "0"}
	case ".m4a":
		return ".m4a", []string{"-c:a", "aac", "-b:a", "256k"}
	case ".aac":
		return ".aac", []string{"-c:a", "aac", "-b:a", "256k"}
	case ".wav":
		return ".wav", []string{"-c:a", "pcm_s16le"}
	case ".flac":
		return ".flac", []string{"-c:a", "flac"}
	case ".ogg":
		return ".ogg", []string{"-c:a", "libopus", "-b:a", "160k"}
	case ".opus":
		return ".opus", []string{"-c:a", "libopus", "-b:a", "160k"}
	}
	return ".m4a", []string{"-c:a", "aac", "-b:a", "256k"}
}

// preciseSpec describes one precise-mode ffmpeg run. Kbps > 0 selects
// bitrate mode (two-pass); Pass is 0 (single), 1 or 2.
type preciseSpec struct {
	In, Out, Graph  string
	VLabel, ALabel  string
	Kbps            int
	Pass            int
	PassLog         string
	AudioOnlyCodecs []string // codec args for audio-only outputs
}

func (p preciseSpec) args() []string {
	a := []string{"-i", p.In, "-filter_complex", p.Graph}
	if p.VLabel != "" {
		a = append(a, "-map", p.VLabel, "-c:v", "libx264", "-preset", x264Preset)
		if p.Kbps > 0 {
			a = append(a, "-b:v", strconv.Itoa(p.Kbps)+"k")
		} else {
			a = append(a, "-crf", x264CRF)
		}
		a = append(a, "-pix_fmt", "yuv420p")
		if p.Pass > 0 {
			a = append(a, "-pass", strconv.Itoa(p.Pass), "-passlogfile", p.PassLog)
		}
	}
	if p.Pass == 1 {
		return append(a, "-an", "-f", "null", "-")
	}
	if p.ALabel != "" {
		a = append(a, "-map", p.ALabel)
		if p.VLabel != "" {
			a = append(a, "-c:a", "aac", "-b:a", defaultAudioBR)
		} else {
			a = append(a, p.AudioOnlyCodecs...)
		}
	}
	a = append(a, "-map_metadata", "0")
	if p.VLabel != "" {
		a = append(a, "-movflags", "+faststart")
	}
	return append(a, p.Out)
}

// commonArgs lead every ffmpeg invocation.
func commonArgs() []string {
	return []string{"-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"}
}
