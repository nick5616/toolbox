package subtitles

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"

	"toolbox/core"
	"toolbox/core/media"
)

// The auto action (SPEC.md §6.4): generate → translate → save → burn/embed
// in one job. Progress: 0–60 % generate, 60–75 % translate, 75–100 % video.
const (
	autoGenerateEnd  = 0.6
	autoTranslateEnd = 0.75
)

// finishFn takes a finished temp video: it moves it to final and records it.
type finishFn func(tmp, final, hint string) error

// standaloneFinish is how a burn or embed job ends on its own: the output,
// the result and the final progress.
func standaloneFinish(job *core.JobContext, o Options) finishFn {
	return func(tmp, final, hint string) error {
		return finishMedia(job, o.Action, tmp, final, hint, len(o.Cues))
	}
}

// validateAuto checks the options of an auto job without touching files.
func validateAuto(o Options) map[string]string {
	f := map[string]string{}
	if _, ok := whisperRepos[o.Model]; !ok {
		f["model"] = "Choose a valid model"
	}
	if o.Language != "" && !validLanguage(o.Language) {
		f["language"] = "Choose a listed language or auto-detect"
	}
	if o.MaxLineChars != 0 && (o.MaxLineChars < 32 || o.MaxLineChars > 60) {
		f["maxLineChars"] = "Choose 32 to 60 characters per line"
	}
	if o.MaxLines != 0 && o.MaxLines != 1 && o.MaxLines != 2 {
		f["maxLines"] = "Choose 1 or 2 lines"
	}
	seen := map[string]bool{}
	for _, x := range o.Formats {
		switch {
		case x != "srt" && x != "vtt":
			f["formats"] = "Unknown subtitle format: " + x
		case seen[x]:
			f["formats"] = "Each format can be chosen once"
		}
		seen[x] = true
	}
	if o.TargetLanguage != "" {
		if !validLanguage(o.TargetLanguage) {
			f["targetLanguage"] = "Choose a language to translate to"
		} else if o.TargetLanguage == o.Language && !o.TranslateToEnglish {
			f["targetLanguage"] = "Choose a different language than the original"
		}
	}
	if o.MaxSizeMB != 0 && (o.MaxSizeMB < 1 || o.MaxSizeMB > 4000) {
		f["maxSizeMB"] = "The size limit must be between 1 and 4000 MB"
	}
	switch o.Video {
	case "", VideoNone:
		if len(o.Formats) == 0 {
			f["formats"] = "Choose subtitle files to save, a video, or both"
		}
	case VideoBurn:
		mergeFields(f, burnLookFields(o))
		mergeFields(f, validateBurnCanvas(o))
	case VideoEmbed:
		if o.TrackLanguage != "" {
			if _, ok := iso639_2[o.TrackLanguage]; !ok {
				f["trackLanguage"] = "Choose a listed language"
			}
		}
	default:
		f["video"] = "Choose no video, burn in or add as a track"
	}
	return f
}

// burnLookFields checks the style, size, position and font of a burn.
func burnLookFields(o Options) map[string]string {
	f := map[string]string{}
	if !slices.ContainsFunc(styles(), func(s StyleInfo) bool { return s.ID == o.Style }) {
		f["style"] = "Choose a style"
	}
	if o.Size != "s" && o.Size != "m" && o.Size != "l" {
		f["size"] = "Choose small, medium or large"
	}
	if o.Position != "bottom" && o.Position != "top" {
		f["position"] = "Choose top or bottom"
	}
	if o.Font != "" && !slices.Contains(media.Fonts(), o.Font) {
		f["font"] = "Choose a listed font"
	}
	return f
}

func (m *Module) runAuto(ctx context.Context, job *core.JobContext, o Options) error {
	input := job.Inputs[0]
	lang, cues, err := m.generateCues(ctx, job, o, 0, autoGenerateEnd)
	if err != nil {
		return err
	}
	if len(cues) == 0 {
		return core.Errorf(core.CodeValidation, "No speech found").WithHint("Check the audio has speech")
	}
	job.Progress(autoGenerateEnd, fmt.Sprintf("%d subtitles", len(cues)))

	stem := core.StemName(input)
	if target := o.TargetLanguage; target != "" {
		source := lang
		if o.TranslateToEnglish {
			source = "en"
		}
		if target != source {
			cues, err = m.translate(ctx, job, cues, source, target, o.MaxLineChars, autoGenerateEnd, autoTranslateEnd)
			if err != nil {
				return err
			}
			lang = target
			stem += "." + target
		}
	}
	job.Progress(autoTranslateEnd, "")

	outs := []string{}
	if len(o.Formats) > 0 {
		saved, err := writeSubtitleFiles(job, cues, stem, o.Formats, "")
		if err != nil {
			return err
		}
		outs = append(outs, saved...)
	}

	video := ""
	fin := func(tmp, final, hint string) error {
		if err := moveFile(tmp, final); err != nil {
			return core.Errorf(core.CodeToolFailed, "Couldn't save the video").WithCause(err)
		}
		if _, err := job.Output(final); err != nil {
			return fmt.Errorf("register output: %w", err)
		}
		if hint != "" {
			job.Log(core.StreamStdout, hint)
		}
		video = final
		return nil
	}
	vj := job.Scoped(autoTranslateEnd, 1)
	switch o.Video {
	case VideoBurn:
		bo := o
		bo.Action, bo.Cues = ActionBurn, cues
		err = m.burn(ctx, vj, bo, fin)
	case VideoEmbed:
		eo := o
		eo.Action, eo.Cues = ActionEmbed, cues
		if eo.TrackLanguage == "" {
			if _, ok := iso639_2[lang]; ok {
				eo.TrackLanguage = lang
			}
		}
		err = m.embed(ctx, vj, eo, fin)
	}
	if err != nil {
		return err
	}
	if video != "" {
		outs = append(outs, video)
	}
	if err := job.SetResult(Result{Action: ActionAuto, Language: lang, Cues: len(cues), Outputs: outs}); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("%d subtitles", len(cues)))
	return nil
}

// Size limits for burned video: the video bitrate comes from the duration
// like Trimmer's (audio re-encoded at 128 kbit/s, 3 % safety margin).
const (
	capAudioBps   = 128000.0
	capMinKbps    = 150
	capSizeMargin = 0.97
)

func capKbps(maxMB int, durSec float64) int {
	total := float64(maxMB) * 8 * 1024 * 1024 * capSizeMargin
	return int((total - capAudioBps*durSec) / durSec / 1000)
}

func tooLong(maxMB int) error {
	return core.ValidationError(fmt.Sprintf("That's too long to fit in %d MB; raise the limit", maxMB),
		map[string]string{"maxSizeMB": "Raise the size limit"})
}

// capArgs turns the quality-based video arguments into a bitrate-limited
// encode. maxMB 0 or an unknown duration leaves args as they are.
func capArgs(args []string, maxMB int, durSec float64) ([]string, error) {
	if maxMB <= 0 || durSec <= 0 {
		return args, nil
	}
	kbps := capKbps(maxMB, durSec)
	if kbps < capMinKbps {
		return nil, tooLong(maxMB)
	}
	k := strconv.Itoa(kbps) + "k"
	out := make([]string, 0, len(args)+8)
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "-crf" && i+1 < len(args):
			out = append(out, "-b:v", k, "-maxrate", k, "-bufsize", strconv.Itoa(2*kbps)+"k")
			i++
		case args[i] == "-c:a" && i+1 < len(args) && args[i+1] == "copy":
			out = append(out, "-c:a", "aac", "-b:a", "128k")
			i++
		case args[i] == "-b:a" && i+1 < len(args):
			out = append(out, "-b:a", "128k")
			i++
		default:
			out = append(out, args[i])
		}
	}
	return out, nil
}

// capSize re-encodes a finished file when it is over maxMB (used after
// renders that FFmpeg's quality mode produced).
func capSize(ctx context.Context, job *core.JobContext, ffmpeg, path string, maxMB int, durSec float64) error {
	if maxMB <= 0 || durSec <= 0 {
		return nil
	}
	fi, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("check size: %w", err)
	}
	if fi.Size() <= int64(maxMB)*1024*1024 {
		return nil
	}
	kbps := capKbps(maxMB, durSec)
	if kbps < capMinKbps {
		return tooLong(maxMB)
	}
	k := strconv.Itoa(kbps) + "k"
	out := filepath.Join(job.TempDir, "capped.mp4")
	args := []string{"-hide_banner", "-nostdin", "-y", "-i", path,
		"-c:v", "libx264", "-preset", "medium", "-b:v", k, "-maxrate", k, "-bufsize", strconv.Itoa(2*kbps) + "k",
		"-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
		"-progress", "pipe:1", "-nostats", out}
	if err := runFFmpegFn(ctx, job.Scoped(0.95, 1), ffmpeg, job.TempDir, args, durSec, "Fitting the size limit"); err != nil {
		return err
	}
	if err := os.Rename(out, path); err != nil {
		return fmt.Errorf("replace video: %w", err)
	}
	return nil
}
