package tts

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"toolbox/core"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

func validateOptions(o Options) error {
	fields := map[string]string{}
	if _, ok := lookupVoice(o.Voice); !ok {
		fields["voice"] = "Choose a voice from the list"
	}
	if !(o.Speed >= MinSpeed && o.Speed <= MaxSpeed) {
		fields["speed"] = fmt.Sprintf("Speed must be between %.1f and %.1f", MinSpeed, MaxSpeed)
	}
	switch o.Split {
	case SplitNone, SplitHeadings:
	default:
		fields["split"] = "Choose one file or one file per heading"
	}
	switch o.Format {
	case FormatMP3, FormatM4A, FormatWAV:
	default:
		fields["format"] = "Choose MP3, M4A or WAV"
	}
	if len(fields) > 0 {
		return core.ValidationError("Some options are invalid", fields)
	}
	return nil
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if err := validateOptions(o); err != nil {
		return err
	}
	fields := map[string]string{}
	for i, in := range inputs {
		if fi, err := os.Stat(in); err == nil && fi.Size() > MaxTextBytes {
			fields[fmt.Sprintf("inputs.%d", i)] = "Too large (limit 8 MB)"
		}
	}
	if len(fields) > 0 {
		return core.ValidationError("Some files can't be used", fields)
	}
	return nil
}

// eventSink maps engine events onto a job, scaling progress into
// [base, base+span].
type eventSink struct {
	job        *core.JobContext
	seen       map[string]bool
	base, span float64
}

func (s *eventSink) onEvent(ev sidecar.Event) {
	switch ev.Kind {
	case "progress":
		pct := ev.Pct
		if pct >= 0 {
			pct = s.base + pct*s.span
		}
		s.job.Progress(pct, ev.Msg)
	case "log":
		stream := core.StreamStdout
		if ev.Level == "warning" || ev.Level == "error" {
			stream = core.StreamStderr
		}
		s.job.Log(stream, ev.Line)
	}
}

// engineResult is tts.speak's answer.
type engineResult struct {
	Files   []FileResult `json:"files"`
	Seconds float64      `json:"seconds"`
	Voice   string       `json:"voice"`
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := validateOptions(o); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add a text file", map[string]string{"inputs": "Add a text file"})
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	ffmpeg := ""
	if !o.Preview && o.Format != FormatWAV {
		if ffmpeg, err = job.Tool("ffmpeg"); err != nil {
			return err
		}
	}
	if err := m.requireModel(); err != nil {
		return err
	}
	input := job.Inputs[0]
	job.SetTitle(filepath.Base(input))
	text, err := readText(input)
	if err != nil {
		return err
	}
	if strings.TrimSpace(text) == "" {
		return core.ValidationError("There's no text to read in this file", map[string]string{"inputs.0": "No text found"})
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return fmt.Errorf("create work dir: %w", err)
	}
	cleaned := filepath.Join(job.TempDir, "text.md")
	if err := os.WriteFile(cleaned, []byte(text), 0o644); err != nil {
		return fmt.Errorf("write the text: %w", err)
	}

	voice, _ := lookupVoice(o.Voice)
	wavDir := filepath.Join(job.TempDir, "wav")
	base := core.StemName(input)
	split := o.Split
	if o.Preview {
		if m.previewDir == "" {
			return core.Errorf(core.CodeInternal, "Previews aren't available")
		}
		wavDir, base, split = m.previewDir, "preview-"+job.ID, SplitNone
		m.prunePreviews()
	}
	span := 1.0
	if ffmpeg != "" {
		span = 0.85
	}
	sink := &eventSink{job: job, seen: map[string]bool{}, span: span}
	raw, err := m.sc.Call(ctx, "tts.speak", map[string]any{
		"input":      cleaned,
		"outputDir":  wavDir,
		"baseName":   base,
		"voice":      o.Voice,
		"speed":      o.Speed,
		"lang":       voice.Lang,
		"split":      string(split),
		"modelPath":  m.modelPath(kokoroFiles[0]),
		"voicesPath": m.modelPath(kokoroFiles[1]),
	}, sink.onEvent)
	if err != nil {
		return err
	}
	var er engineResult
	if err := json.Unmarshal(raw, &er); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	if len(er.Files) == 0 {
		return core.Errorf(core.CodeToolFailed, "The voice didn't produce any audio")
	}

	res := Result{Files: []FileResult{}, Seconds: er.Seconds, Voice: o.Voice}
	if o.Preview {
		res.Files = er.Files
		res.PreviewPath = er.Files[0].Path
		if err := job.SetResult(res); err != nil {
			return err
		}
		job.Progress(1, "Preview ready")
		return nil
	}

	for i, f := range er.Files {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("text to speech cancelled: %w", err)
		}
		stem := core.StemName(f.Path)
		final := core.UniquePath(job.OutputDir, stem, "."+string(o.Format))
		if o.Format == FormatWAV {
			if err := moveFile(f.Path, final); err != nil {
				return core.Errorf(core.CodeToolFailed, "Couldn't save the audio").WithCause(err)
			}
		} else {
			title := f.Title
			if title == "" {
				title = core.StemName(input)
			}
			args := encodeArgs(o.Format, f.Path, final, title, core.StemName(input), i+1, len(er.Files))
			if err := m.ffmpeg(ctx, ffmpeg, job.TempDir, args); err != nil {
				return err
			}
			job.Progress(span+(1-span)*float64(i+1)/float64(len(er.Files)), "Encoding "+strings.ToUpper(string(o.Format)))
		}
		if _, err := job.Output(final); err != nil {
			return fmt.Errorf("register output: %w", err)
		}
		f.Path = final
		res.Files = append(res.Files, f)
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, summary(res))
	return nil
}

// encodeArgs is the FFmpeg command line that turns a wav into mp3 or m4a.
func encodeArgs(format Format, in, out, title, album string, track, tracks int) []string {
	args := []string{"-hide_banner", "-nostdin", "-nostats", "-y", "-i", in, "-vn", "-ac", "1", "-ar", "44100"}
	switch format {
	case FormatM4A:
		args = append(args, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart")
	default:
		args = append(args, "-c:a", "libmp3lame", "-q:a", "4")
	}
	args = append(args,
		"-metadata", "title="+title,
		"-metadata", "album="+album,
		"-metadata", "track="+strconv.Itoa(track)+"/"+strconv.Itoa(tracks),
		out)
	return args
}

func (m *Module) ffmpeg(ctx context.Context, path, dir string, args []string) error {
	res, err := proc.Run(ctx, proc.Spec{Path: path, Args: args, Dir: dir})
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("text to speech cancelled: %w", ctx.Err())
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return core.Errorf(core.CodeToolFailed, "FFmpeg couldn't encode the audio").WithHint(hint).WithCause(err)
	}
	return nil
}

// summary is the final job message: "3 files · 12 min 4 s".
func summary(r Result) string {
	sec := int(r.Seconds + 0.5)
	var dur string
	switch {
	case sec >= 3600:
		dur = fmt.Sprintf("%d h %d min", sec/3600, sec%3600/60)
	case sec >= 60:
		dur = fmt.Sprintf("%d min %d s", sec/60, sec%60)
	default:
		dur = fmt.Sprintf("%d s", sec)
	}
	if len(r.Files) > 1 {
		return fmt.Sprintf("%d chapters · %s", len(r.Files), dur)
	}
	return dur + " of speech"
}

// moveFile renames src to dst, copying across volumes when needed.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return err
	}
	return os.Remove(src)
}
