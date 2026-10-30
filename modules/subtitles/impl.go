package subtitles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

const (
	maxCues     = 20000
	maxCueChars = 500
)

// whisperRepos maps Transcribe's model presets to their faster-whisper repos
// (kept in step with modules/transcribe/presets.go).
var whisperRepos = map[string]string{
	"base":  "Systran/faster-whisper-base",
	"small": "Systran/faster-whisper-small",
	"turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}

func (a Action) needsMedia() bool {
	return a == ActionGenerate || a == ActionExtract || a == ActionBurn || a == ActionEmbed
}

func isSubtitleExt(path string) bool {
	e := strings.ToLower(filepath.Ext(path))
	return e == ".srt" || e == ".vtt"
}

func validLanguage(code string) bool {
	return slices.ContainsFunc(translationLanguages(), func(l Language) bool { return l.Code == code })
}

func validateCues(cues []Cue) map[string]string {
	switch {
	case len(cues) == 0:
		return map[string]string{"cues": "There are no subtitles yet"}
	case len(cues) > maxCues:
		return map[string]string{"cues": fmt.Sprintf("Too many subtitles (the limit is %d)", maxCues)}
	}
	prev := int64(-1)
	for i, c := range cues {
		switch {
		case c.StartMs < 0 || c.EndMs <= c.StartMs:
			return map[string]string{"cues": fmt.Sprintf("Subtitle %d must end after it starts", i+1)}
		case c.StartMs < prev:
			return map[string]string{"cues": fmt.Sprintf("Subtitle %d is out of order", i+1)}
		case runeLen(c.Text) > maxCueChars:
			return map[string]string{"cues": fmt.Sprintf("Subtitle %d is longer than %d characters", i+1, maxCueChars)}
		case strings.TrimSpace(c.Text) == "":
			return map[string]string{"cues": fmt.Sprintf("Subtitle %d is empty", i+1)}
		}
		prev = c.StartMs
	}
	return nil
}

func mergeFields(dst, src map[string]string) {
	for k, v := range src {
		dst[k] = v
	}
}

// validateOptions checks the options of o.Action without touching files.
func validateOptions(o Options) error {
	f := map[string]string{}
	lineChars := func() {
		if o.MaxLineChars != 0 && (o.MaxLineChars < 32 || o.MaxLineChars > 60) {
			f["maxLineChars"] = "Choose 32 to 60 characters per line"
		}
	}
	switch o.Action {
	case ActionGenerate:
		if _, ok := whisperRepos[o.Model]; !ok {
			f["model"] = "Choose a valid model"
		}
		if o.Language != "" && !validLanguage(o.Language) {
			f["language"] = "Choose a listed language or auto-detect"
		}
		lineChars()
		if o.MaxLines != 0 && o.MaxLines != 1 && o.MaxLines != 2 {
			f["maxLines"] = "Choose 1 or 2 lines"
		}
		for _, x := range o.Formats {
			if x != "srt" && x != "vtt" {
				f["formats"] = "Unknown subtitle format: " + x
			}
		}
	case ActionExtract:
		if o.StreamIndex < 0 {
			f["streamIndex"] = "Choose a subtitle stream"
		}
	case ActionSave:
		mergeFields(f, validateCues(o.Cues))
		if len(o.Formats) == 0 {
			f["formats"] = "Choose at least one format"
		}
		seen := map[string]bool{}
		for _, x := range o.Formats {
			if x != "srt" && x != "vtt" {
				f["formats"] = "Unknown subtitle format: " + x
			} else if seen[x] {
				f["formats"] = "Each format can be chosen once"
			}
			seen[x] = true
		}
	case ActionTranslate:
		mergeFields(f, validateCues(o.Cues))
		if !validLanguage(o.TargetLanguage) {
			f["targetLanguage"] = "Choose a language to translate to"
		}
		if o.SourceLanguage != "" && !validLanguage(o.SourceLanguage) {
			f["sourceLanguage"] = "Choose a listed language or leave it unknown"
		}
		if o.SourceLanguage != "" && o.SourceLanguage == o.TargetLanguage {
			f["targetLanguage"] = "Choose a different language than the original"
		}
		lineChars()
	case ActionBurn:
		mergeFields(f, validateCues(o.Cues))
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
		mergeFields(f, validateBurnCanvas(o))
	case ActionEmbed:
		mergeFields(f, validateCues(o.Cues))
		if o.TrackLanguage != "" {
			if _, ok := iso639_2[o.TrackLanguage]; !ok {
				f["trackLanguage"] = "Choose a listed language"
			}
		}
	default:
		f["action"] = "Choose what to do"
	}
	if len(f) > 0 {
		return core.ValidationError("Some options are invalid", f)
	}
	return nil
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if len(inputs) != 1 {
		return core.ValidationError("Choose one file", map[string]string{"inputs": "Choose one file"})
	}
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
	if o.Action.needsMedia() && isSubtitleExt(inputs[0]) {
		return core.ValidationError("Choose a video or audio file", map[string]string{"inputs.0": "This needs a video or audio file"})
	}
	if o.Action != ActionExtract && o.Action != ActionBurn && o.Action != ActionEmbed {
		return nil
	}
	if m.resolve == nil {
		return nil
	}
	ffprobe, err := m.resolve("ffprobe")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	info, err := media.Probe(ctx, ffprobe, inputs[0])
	if err != nil {
		return err
	}
	return checkStreams(o, info)
}

// checkStreams applies the stream requirements of burn, embed and extract.
func checkStreams(o Options, info media.Info) error {
	switch o.Action {
	case ActionBurn, ActionEmbed:
		if info.Video == nil && (o.Action == ActionEmbed || !burnsAudio(o)) {
			return core.ValidationError("This needs a video file", map[string]string{"inputs.0": "No video stream found"})
		}
	case ActionExtract:
		for _, s := range info.Subtitles {
			if s.Index == o.StreamIndex {
				if !s.Text {
					return core.ValidationError("That subtitle track is made of images and can't be extracted", map[string]string{"streamIndex": "Choose a text subtitle track"})
				}
				return nil
			}
		}
		return core.ValidationError("That subtitle track doesn't exist", map[string]string{"streamIndex": "Choose a subtitle track"})
	}
	return nil
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := validateOptions(o); err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Choose one file", map[string]string{"inputs": "Choose one file"})
	}
	job.SetTitle(filepath.Base(job.Inputs[0]))
	switch o.Action {
	case ActionGenerate:
		return m.runGenerate(ctx, job, o)
	case ActionExtract:
		return m.runExtract(ctx, job, o)
	case ActionSave:
		return m.runSave(job, o)
	case ActionTranslate:
		return m.runTranslate(ctx, job, o)
	case ActionBurn:
		return m.runBurn(ctx, job, o)
	case ActionEmbed:
		return m.runEmbed(ctx, job, o)
	}
	return core.ValidationError("Choose what to do", nil)
}

// writeSubtitleFiles writes cues to <OutputDir>/<stem>.<fmt> for each
// format and registers them. overwrite, when set, is an existing path of
// this module that is replaced for its own format.
func writeSubtitleFiles(job *core.JobContext, cues []Cue, stem string, formats []string, overwrite string) ([]string, error) {
	var outs []string
	for _, f := range formats {
		body := formatSRT(cues)
		if f == "vtt" {
			body = formatVTT(cues)
		}
		var dst string
		if overwrite != "" && strings.EqualFold(strings.TrimPrefix(filepath.Ext(overwrite), "."), f) {
			dst = overwrite
		} else {
			dst = core.UniquePath(job.OutputDir, stem, "."+f)
		}
		if err := writeFileAtomic(dst, []byte(body)); err != nil {
			return outs, core.Errorf(core.CodeToolFailed, "Couldn't save the subtitle file").WithCause(err)
		}
		if _, err := job.Output(dst); err != nil {
			return outs, fmt.Errorf("register output: %w", err)
		}
		outs = append(outs, dst)
	}
	return outs, nil
}

func writeFileAtomic(dst string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func finishResult(job *core.JobContext, o Options, language string, cues int, outs []string) error {
	if outs == nil {
		outs = []string{}
	}
	return job.SetResult(Result{Action: o.Action, Language: language, Cues: cues, Outputs: outs})
}

// engineDoc is the transcribe.run JSON output.
type engineDoc struct {
	Language string `json:"language"`
	Segments []struct {
		Start float64 `json:"start"`
		End   float64 `json:"end"`
		Text  string  `json:"text"`
		Words []struct {
			Start float64 `json:"start"`
			End   float64 `json:"end"`
			Word  string  `json:"word"`
		} `json:"words"`
	} `json:"segments"`
}

func secMs(s float64) int64 { return int64(math.Round(s * 1000)) }

func parseEngineDoc(b []byte) (string, []rawSegment, error) {
	var d engineDoc
	if err := json.Unmarshal(b, &d); err != nil {
		return "", nil, err
	}
	segs := make([]rawSegment, 0, len(d.Segments))
	for _, s := range d.Segments {
		rs := rawSegment{StartMs: secMs(s.Start), EndMs: secMs(s.End), Text: s.Text}
		for _, w := range s.Words {
			rs.Words = append(rs.Words, rawWord{StartMs: secMs(w.Start), EndMs: secMs(w.End), Text: w.Word})
		}
		segs = append(segs, rs)
	}
	return d.Language, segs, nil
}

func (m *Module) runGenerate(ctx context.Context, job *core.JobContext, o Options) error {
	if m.sc == nil {
		return core.Errorf(core.CodeDependencyMissing, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	input := job.Inputs[0]
	var language any
	if o.Language != "" {
		language = o.Language
	}
	task := "transcribe"
	if o.TranslateToEnglish {
		task = "translate"
	}
	params := map[string]any{
		"input": input, "outputDir": job.TempDir, "baseName": "transcript",
		"model": whisperRepos[o.Model], "modelDir": filepath.Join(m.modelsDir, "whisper", o.Model),
		"language": language, "task": task, "formats": []string{"json"}, "vad": true,
	}
	scoped := job.Scoped(0, 0.9)
	raw, err := m.sc.Call(ctx, "transcribe.run", params, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			scoped.Progress(ev.Pct, ev.Msg)
		case "log":
			stream := core.StreamStdout
			if ev.Level == "warning" || ev.Level == "error" {
				stream = core.StreamStderr
			}
			job.Log(stream, ev.Line)
		}
	})
	if err != nil {
		return err
	}
	var res struct {
		Language string `json:"language"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	data, err := os.ReadFile(filepath.Join(job.TempDir, "transcript.json"))
	if err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine didn't produce a transcript").WithCause(err)
	}
	lang, segs, err := parseEngineDoc(data)
	if err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable transcript").WithCause(err)
	}
	if lang == "" {
		lang = res.Language
	}
	cues := buildCues(segs, o.MaxLineChars, o.MaxLines)
	if len(cues) == 0 {
		job.Progress(1, "No speech found")
		return finishResult(job, o, lang, 0, nil)
	}
	formats := o.Formats
	if len(formats) == 0 {
		formats = []string{"srt"}
	}
	outs, err := writeSubtitleFiles(job, cues, core.StemName(input), formats, "")
	if err != nil {
		return err
	}
	if err := finishResult(job, o, lang, len(cues), outs); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("%d subtitles", len(cues)))
	return nil
}

func (m *Module) runExtract(ctx context.Context, job *core.JobContext, o Options) error {
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	input := job.Inputs[0]
	tmp := filepath.Join(job.TempDir, "extract.srt")
	args := []string{"-hide_banner", "-nostdin", "-y", "-i", input, "-map", fmt.Sprintf("0:%d", o.StreamIndex), "-c:s", "srt", tmp}
	if err := runFFmpeg(ctx, job, ffmpeg, job.TempDir, args, 0, "Extracting subtitles"); err != nil {
		return err
	}
	b, err := os.ReadFile(tmp)
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't read the extracted subtitles").WithCause(err)
	}
	cues := parseCues(decodeText(b))
	if len(cues) == 0 {
		return core.Errorf(core.CodeToolFailed, "That subtitle track has no text")
	}
	final := core.UniquePath(job.OutputDir, core.StemName(input), ".srt")
	if err := moveFile(tmp, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the subtitle file").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	if err := finishResult(job, o, "", len(cues), []string{final}); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("%d subtitles", len(cues)))
	return nil
}

// canOverwrite reports whether input may be replaced by Save: a .srt/.vtt
// file directly inside the module's own output folder.
func canOverwrite(input, outputDir string) bool {
	if !isSubtitleExt(input) {
		return false
	}
	resolve := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			p = r
		}
		if a, err := filepath.Abs(p); err == nil {
			p = a
		}
		return filepath.Clean(p)
	}
	// Case-insensitive: macOS and Windows volumes.
	return strings.EqualFold(resolve(filepath.Dir(input)), resolve(outputDir))
}

func (m *Module) runSave(job *core.JobContext, o Options) error {
	input := job.Inputs[0]
	overwrite := ""
	if canOverwrite(input, job.OutputDir) {
		overwrite = input
	}
	outs, err := writeSubtitleFiles(job, o.Cues, core.StemName(input), o.Formats, overwrite)
	if err != nil {
		return err
	}
	if err := finishResult(job, o, "", len(o.Cues), outs); err != nil {
		return err
	}
	job.Progress(1, "Saved")
	return nil
}

const openChatHint = "Open Local Chat and download a model"

func (m *Module) runTranslate(ctx context.Context, job *core.JobContext, o Options) error {
	if m.tg == nil {
		return core.Errorf(core.CodeDependencyMissing, "Local Chat isn't available").WithHint(openChatHint)
	}
	if _, err := m.tg.Ready(); err != nil {
		var ae *core.AppError
		if errors.As(err, &ae) && ae.Hint == "" {
			ae.Hint = openChatHint
		}
		return err
	}
	total := len(o.Cues)
	job.Progress(0, "Translating…")
	translated, err := translateCues(ctx, m.tg, o.Cues, o.SourceLanguage, o.TargetLanguage, o.MaxLineChars, func(done int) {
		job.Progress(float64(done)/float64(total), fmt.Sprintf("Translated %d of %d", done, total))
	})
	if err != nil {
		return err
	}
	stem := core.StemName(job.Inputs[0]) + "." + o.TargetLanguage
	dst := core.UniquePath(job.OutputDir, stem, ".srt")
	if err := writeFileAtomic(dst, []byte(formatSRT(translated))); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the subtitle file").WithCause(err)
	}
	if _, err := job.Output(dst); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	if err := finishResult(job, o, o.TargetLanguage, total, []string{dst}); err != nil {
		return err
	}
	job.Progress(1, "Translated to "+languageName(o.TargetLanguage))
	return nil
}

// runFFmpeg runs ffmpeg with -progress output mapped to job progress.
// durationSec <= 0 means unknown.
func runFFmpeg(ctx context.Context, job *core.JobContext, ffmpeg, dir string, args []string, durationSec float64, label string) error {
	tracker := &media.ProgressTracker{Duration: durationSec, Label: label}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	job.Progress(core.IndeterminateProgress, label+"…")
	res, runErr := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: args, Dir: dir,
		OnStdout: func(l string) {
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				job.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			job.Log(core.StreamStderr, l)
			mu.Lock()
			if strings.TrimSpace(l) != "" {
				lastStderr = l
			}
			mu.Unlock()
		},
	})
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%s cancelled: %w", strings.ToLower(label), err)
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return fmt.Errorf("run ffmpeg: %w", runErr)
		}
		mu.Lock()
		msg := lastStderr
		mu.Unlock()
		if msg == "" {
			msg = fmt.Sprintf("ffmpeg exited with code %d", res.ExitCode)
		}
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(runErr)
	}
	return nil
}

// moveFile renames src to dst, falling back to copy+remove across volumes.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dst)
		return fmt.Errorf("copy to %s: %w", dst, err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("close %s: %w", dst, err)
	}
	_ = os.Remove(src)
	return nil
}

// finishMedia moves a rendered file into the library and records the result.
func finishMedia(job *core.JobContext, action Action, tmp, final, hint string, cues int) error {
	if err := moveFile(tmp, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the video").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	if hint != "" {
		job.Log(core.StreamStdout, hint)
	}
	if err := job.SetResult(Result{Action: action, Cues: cues, Outputs: []string{final}}); err != nil {
		return err
	}
	msg := "Saved " + filepath.Base(final)
	if hint != "" {
		msg += " · " + hint
	}
	job.Progress(1, msg)
	return nil
}

func translationLanguages() []Language {
	return []Language{
		{"ar", "Arabic"}, {"bn", "Bengali"}, {"ca", "Catalan"}, {"zh", "Chinese"}, {"cs", "Czech"},
		{"da", "Danish"}, {"nl", "Dutch"}, {"en", "English"}, {"tl", "Filipino"}, {"fi", "Finnish"},
		{"fr", "French"}, {"de", "German"}, {"el", "Greek"}, {"he", "Hebrew"}, {"hi", "Hindi"},
		{"hu", "Hungarian"}, {"id", "Indonesian"}, {"it", "Italian"}, {"ja", "Japanese"}, {"ko", "Korean"},
		{"ms", "Malay"}, {"no", "Norwegian"}, {"fa", "Persian"}, {"pl", "Polish"}, {"pt", "Portuguese"},
		{"ro", "Romanian"}, {"ru", "Russian"}, {"es", "Spanish"}, {"sw", "Swahili"}, {"sv", "Swedish"},
		{"ta", "Tamil"}, {"th", "Thai"}, {"tr", "Turkish"}, {"uk", "Ukrainian"}, {"ur", "Urdu"},
		{"vi", "Vietnamese"},
	}
}

func styles() []StyleInfo {
	return []StyleInfo{
		{StyleClassic, "Classic"}, {StyleBoxed, "Boxed"}, {StyleYellow, "Yellow"}, {StyleMinimal, "Minimal"},
	}
}

func (m *Module) translatorStatus() TranslatorStatus {
	if m.tg == nil {
		return TranslatorStatus{Error: "Local Chat isn't available"}
	}
	model, err := m.tg.Ready()
	if err != nil {
		msg := err.Error()
		var ae *core.AppError
		if errors.As(err, &ae) {
			msg = ae.Message
			if ae.Hint != "" {
				msg += ". " + ae.Hint
			}
		}
		return TranslatorStatus{Error: msg}
	}
	return TranslatorStatus{Ready: true, Model: model}
}
