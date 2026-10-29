package audiocleanup

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"strings"

	"toolbox/core"
)

// rnnoiseFile is the embedded model's file name inside the job's TempDir.
const rnnoiseFile = "std.rnnn"

// previewSeconds is the length of an A/B excerpt.
const previewSeconds = 10

// loudnessTarget is an EBU R128 style target (SPEC.md §6.1).
type loudnessTarget struct {
	I, TP, LRA float64
}

func targetFor(l Loudness) (loudnessTarget, bool) {
	switch l {
	case LoudnessPodcast:
		return loudnessTarget{-16, -1.5, 11}, true
	case LoudnessStreaming:
		return loudnessTarget{-14, -1.0, 11}, true
	case LoudnessBroadcast:
		return loudnessTarget{-23, -1.0, 11}, true
	}
	return loudnessTarget{}, false
}

func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// humFilters are the mains notches for fundamental hz (k = 1..4).
func humFilters(hz int) []string {
	if hz <= 0 {
		return nil
	}
	out := make([]string, 0, 4)
	for k := 1; k <= 4; k++ {
		out = append(out, fmt.Sprintf("bandreject=f=%d:width_type=q:w=30", hz*k))
	}
	return out
}

// preFilters are the filters that run before any denoiser: the 80 Hz
// high-pass and the hum notches.
func preFilters(o Options, humHz int) []string {
	var f []string
	if o.HighPass {
		f = append(f, "highpass=f=80")
	}
	return append(f, humFilters(humHz)...)
}

// ffmpegDenoise is the FFmpeg-side denoise filter ("" for off and voice).
func ffmpegDenoise(d Denoise) string {
	switch d {
	case DenoiseLight:
		return "afftdn=nr=12:nf=-50:tn=1"
	case DenoiseStrong:
		return "arnndn=m=" + rnnoiseFile
	}
	return ""
}

// inlineFilters is the whole FFmpeg-side chain before loudness for the
// non-voice modes. Voice isolation runs preFilters in its own step, then the
// engine, then nothing before loudness.
func inlineFilters(o Options, humHz int) []string {
	f := preFilters(o, humHz)
	if d := ffmpegDenoise(o.Denoise); d != "" {
		f = append(f, d)
	}
	return f
}

func join(f []string) string { return strings.Join(f, ",") }

func loudnormBase(t loudnessTarget) string {
	return fmt.Sprintf("loudnorm=I=%s:TP=%s:LRA=%s", num(t.I), num(t.TP), num(t.LRA))
}

// loudnormPass1 measures only.
func loudnormPass1(t loudnessTarget) string { return loudnormBase(t) + ":print_format=json" }

// loudnormPass2 applies the measured values with linear gain, then brings
// the 192 kHz loudnorm output back to a normal rate.
func loudnormPass2(t loudnessTarget, s loudnormStats, rate int) string {
	return fmt.Sprintf("%s:measured_I=%s:measured_TP=%s:measured_LRA=%s:measured_thresh=%s:offset=%s:linear=true:print_format=json,aresample=%d",
		loudnormBase(t), s.InputI, s.InputTP, s.InputLRA, s.InputThresh, s.TargetOffset, rate)
}

// outRate is the sample rate after loudnorm: 44.1 kHz stays, anything else 48 kHz.
func outRate(inRate int) int {
	if inRate == 44100 {
		return 44100
	}
	return 48000
}

func withFilters(parts ...[]string) string {
	var all []string
	for _, p := range parts {
		all = append(all, p...)
	}
	return join(all)
}

// loudnormStats is loudnorm's print_format=json output (values are strings
// so they can be passed back verbatim).
type loudnormStats struct {
	InputI       string `json:"input_i"`
	InputTP      string `json:"input_tp"`
	InputLRA     string `json:"input_lra"`
	InputThresh  string `json:"input_thresh"`
	OutputI      string `json:"output_i"`
	OutputTP     string `json:"output_tp"`
	TargetOffset string `json:"target_offset"`
}

// parseLoudnorm finds the last JSON object in FFmpeg's stderr lines.
func parseLoudnorm(lines []string) (loudnormStats, error) {
	var st loudnormStats
	end := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == "}" {
			end = i
			break
		}
	}
	if end < 0 {
		return st, fmt.Errorf("no loudnorm output")
	}
	start := -1
	for i := end; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == "{" {
			start = i
			break
		}
	}
	if start < 0 {
		return st, fmt.Errorf("no loudnorm output")
	}
	if err := json.Unmarshal([]byte(strings.Join(lines[start:end+1], "\n")), &st); err != nil {
		return st, fmt.Errorf("reading loudnorm output: %w", err)
	}
	for _, v := range []string{st.InputI, st.InputTP, st.InputLRA, st.InputThresh, st.TargetOffset} {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return st, core.Errorf(core.CodeValidation, "This file has no audible sound to normalise")
		}
	}
	return st, nil
}

// parseEBU128 returns the integrated loudness from an ebur128 summary
// (framelog=quiet), or false when it is missing or -inf.
func parseEBU128(lines []string) (float64, bool) {
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(l, "I:") || !strings.HasSuffix(l, "LUFS") {
			continue
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(l, "I:"), "LUFS")), 64)
		if err != nil || math.IsInf(f, 0) {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

func isVideoExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".3gp":
		return true
	}
	return false
}

// encoding describes the output container and audio codec.
type encoding struct {
	Ext  string
	Args []string // codec and container args, placed before the output path
}

// audioEncoding picks the output for an audio input (SPEC.md §6.2 step 4).
func audioEncoding(inputExt string, f Format) encoding {
	wav := encoding{".wav", []string{"-c:a", "pcm_s24le"}}
	flac := encoding{".flac", []string{"-c:a", "flac"}}
	mp3 := encoding{".mp3", []string{"-c:a", "libmp3lame", "-b:a", "320k"}}
	m4a := encoding{".m4a", []string{"-c:a", "aac", "-b:a", "256k"}}
	switch f {
	case FormatWAV:
		return wav
	case FormatFLAC:
		return flac
	case FormatMP3:
		return mp3
	case FormatM4A:
		return m4a
	}
	switch strings.ToLower(inputExt) {
	case ".wav":
		return wav
	case ".flac":
		return flac
	case ".mp3":
		return mp3
	case ".aac":
		return encoding{".aac", []string{"-c:a", "aac", "-b:a", "256k"}}
	case ".ogg":
		return encoding{".ogg", []string{"-c:a", "libopus", "-b:a", "192k"}}
	case ".opus":
		return encoding{".opus", []string{"-c:a", "libopus", "-b:a", "192k"}}
	case ".aiff", ".aif":
		return encoding{strings.ToLower(inputExt), []string{"-c:a", "pcm_s24be"}}
	}
	return m4a // .m4a, .wma and anything else
}

// videoEncoding keeps the container and re-encodes only the audio.
func videoEncoding(inputExt string) encoding {
	ext := strings.ToLower(inputExt)
	switch ext {
	case ".webm", ".mkv":
		return encoding{ext, []string{"-c:v", "copy", "-c:a", "libopus", "-b:a", "160k"}}
	case ".wmv":
		return encoding{ext, []string{"-c:v", "copy", "-c:a", "wmav2", "-b:a", "192k"}}
	case ".mp4", ".m4v", ".mov":
		return encoding{ext, []string{"-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"}}
	}
	return encoding{ext, []string{"-c:v", "copy", "-c:a", "aac", "-b:a", "192k"}}
}

// previewEncoding is the 16-bit WAV used for the A/B players.
func previewEncoding() encoding {
	return encoding{".wav", []string{"-c:a", "pcm_s16le"}}
}

// previewSpan clamps a preview start so the excerpt fits in the file.
func previewSpan(startMs, durationMs int64) (start, length float64) {
	length = previewSeconds
	if durationMs > 0 && float64(durationMs)/1000 < length {
		length = float64(durationMs) / 1000
	}
	s := float64(max(startMs, 0)) / 1000
	if durationMs > 0 {
		if over := s + length - float64(durationMs)/1000; over > 0 {
			s = max(0, s-over)
		}
	}
	return s, length
}

// previewNames are the A and B excerpt paths for a job.
func previewNames(dir, jobID string) (a, b string) {
	return filepath.Join(dir, jobID+"-a.wav"), filepath.Join(dir, jobID+"-b.wav")
}
