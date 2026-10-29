package subtitles

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
)

// iso639_2 maps the offered ISO 639-1 codes to ISO 639-2 for track tags.
var iso639_2 = map[string]string{
	"ar": "ara", "bn": "ben", "ca": "cat", "zh": "zho", "cs": "ces", "da": "dan", "nl": "nld", "en": "eng",
	"tl": "fil", "fi": "fin", "fr": "fra", "de": "deu", "el": "ell", "he": "heb", "hi": "hin", "hu": "hun",
	"id": "ind", "it": "ita", "ja": "jpn", "ko": "kor", "ms": "msa", "no": "nor", "fa": "fas", "pl": "pol",
	"pt": "por", "ro": "ron", "ru": "rus", "es": "spa", "sw": "swa", "sv": "swe", "ta": "tam", "th": "tha",
	"tr": "tur", "uk": "ukr", "ur": "urd", "vi": "vie",
}

// embedPlan picks the subtitle codec and output extension for an input
// extension. remuxed is true when the container can't hold the track.
func embedPlan(ext string) (codec, outExt string, remuxed bool) {
	ext = strings.ToLower(ext)
	switch ext {
	case ".mp4", ".mov", ".m4v":
		return "mov_text", ext, false
	case ".mkv":
		return "srt", ".mkv", false
	case ".webm":
		return "webvtt", ".webm", false
	}
	return "srt", ".mkv", true
}

// embedArgs builds the ffmpeg arguments; n is the new track's index among
// the output's subtitle streams.
func embedArgs(input, srt, out, codec, lang string, n int) []string {
	if lang == "" {
		lang = "und"
	} else if l3, ok := iso639_2[lang]; ok {
		lang = l3
	}
	return []string{"-hide_banner", "-nostdin", "-y", "-i", input, "-i", srt,
		"-map", "0", "-map", "1", "-c", "copy",
		fmt.Sprintf("-c:s:%d", n), codec,
		fmt.Sprintf("-metadata:s:s:%d", n), "language=" + lang,
		"-progress", "pipe:1", "-nostats", out}
}

func (m *Module) runEmbed(ctx context.Context, job *core.JobContext, o Options) error {
	input := job.Inputs[0]
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	info, err := media.Probe(ctx, ffprobe, input)
	if err != nil {
		return err
	}
	if info.Video == nil {
		return core.ValidationError("Adding a subtitle track needs a video file", nil)
	}
	codec, outExt, remuxed := embedPlan(filepath.Ext(input))
	srt := filepath.Join(job.TempDir, "subs.srt")
	if err := os.WriteFile(srt, []byte(formatSRT(o.Cues)), 0o644); err != nil {
		return fmt.Errorf("write subs.srt: %w", err)
	}
	tmp := filepath.Join(job.TempDir, "embed"+outExt)
	args := embedArgs(input, srt, tmp, codec, o.TrackLanguage, len(info.Subtitles))
	if err := runFFmpeg(ctx, job, ffmpeg, job.TempDir, args, float64(info.DurationMs)/1000, "Adding subtitle track"); err != nil {
		return err
	}
	final := core.UniquePath(job.OutputDir, core.StemName(input)+" (subs)", outExt)
	hint := ""
	if remuxed {
		hint = "This container can't hold a subtitle track, so the video was remuxed into .mkv"
	}
	return finishMedia(job, o.Action, tmp, final, hint, len(o.Cues))
}
