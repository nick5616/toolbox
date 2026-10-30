package viz

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/lyrics"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

const (
	whisperModel = "small"
	whisperRepo  = "Systran/faster-whisper-small"

	instrumentalName = "instrumental.flac"

	warnNoReader      = "Mood reader not installed: mood comes from the music only"
	warnNoReaderChat  = "Mood reader not installed: using the Local Chat reading alone"
	warnWeakAlignment = "Couldn't follow the song well — check the timings"
	warnNoWords       = "No words were recognised in this song"
)

// runFFmpeg runs ffmpeg (a seam for tests).
var runFFmpeg = func(ctx context.Context, ffmpeg string, args []string) error {
	res, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: args})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return core.Errorf(core.CodeToolFailed, "Couldn't mix the instrumental").
			WithHint(strings.Join(res.StderrTail[max(0, len(res.StderrTail)-3):], " ")).WithCause(err)
	}
	return nil
}

// instrumentalArgs mixes drums, bass and other into dst.
func instrumentalArgs(drums, bass, other, dst string) []string {
	return []string{"-hide_banner", "-nostdin", "-y",
		"-i", drums, "-i", bass, "-i", other,
		"-filter_complex", "amix=inputs=3:normalize=0",
		"-c:a", "flac", dst}
}

// validateAnalyze checks the words options.
func validateAnalyze(o AnalyzeOptions) error {
	bad := func(field, msg string) error {
		return core.ValidationError(msg, map[string]string{field: msg})
	}
	switch o.Words {
	case "", WordsNone, WordsDetect:
	case WordsAlign:
		if strings.TrimSpace(o.LyricsText) == "" {
			return bad("lyricsText", "Paste the lyrics first")
		}
	case WordsFile:
		if o.LyricsPath == "" {
			return bad("lyricsPath", "Choose a lyrics file")
		}
	case WordsGiven:
		if len(o.Lines) == 0 {
			return bad("lines", "There are no lines to use")
		}
		if len(o.Lines) > MaxGivenLines {
			return bad("lines", fmt.Sprintf("Use at most %d lines", MaxGivenLines))
		}
	default:
		return bad("words", "Choose where the words come from")
	}
	if len([]rune(o.LyricsText)) > MaxLyricsChars {
		return bad("lyricsText", fmt.Sprintf("Use at most %d characters of lyrics", MaxLyricsChars))
	}
	return nil
}

// wordsPlan says how the words are obtained, resolved before any engine work.
type wordsPlan struct {
	source     WordsSource
	lines      []lyrics.Line // given, or a timed file
	text       string        // to align
	transcribe bool
}

func planWords(o AnalyzeOptions) (wordsPlan, error) {
	p := wordsPlan{source: o.Words}
	switch o.Words {
	case WordsDetect:
		p.transcribe = true
	case WordsAlign:
		p.text, p.transcribe = o.LyricsText, true
	case WordsGiven:
		p.lines = slices.Clone(o.Lines)
	case WordsFile:
		lines, text, needsAlign, err := lyrics.ParseFile(o.LyricsPath)
		if err != nil {
			return p, core.Errorf(core.CodeNotFound, "Couldn't read the lyrics file").WithHint(o.LyricsPath).WithCause(err)
		}
		if needsAlign {
			if strings.TrimSpace(text) == "" {
				return p, core.ValidationError("That lyrics file is empty", map[string]string{"lyricsPath": "That lyrics file is empty"})
			}
			p.text, p.transcribe = text, true
		} else {
			if len(lines) == 0 {
				return p, core.Errorf(core.CodeValidation, "No lyric lines found in that file").WithHint("Check that it has timestamps")
			}
			p.lines = lines
		}
	}
	return p, nil
}

func fileOK(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Size() > 0
}

// analysis is the state of one Analyze run.
type analysis struct {
	a       *Analyzer
	job     *core.JobContext
	o       AnalyzeOptions
	input   string
	folder  string
	stems   string // <folder>/stems
	created []string
	paths   map[string]string // lower-case stem name -> path
	audio   string            // what the engine decodes: the input, or a WAV extracted from it
}

// engineReads lists the formats the engine's decoder (libsndfile) opens
// directly; everything else (video, m4a, aac, opus, wma…) is extracted first.
var engineReads = map[string]bool{".wav": true, ".flac": true, ".mp3": true, ".ogg": true, ".aiff": true, ".aif": true}

// engineAudio returns a path the engine can decode, extracting the input's
// first audio stream to a temporary WAV in the analysis folder when needed
// (44.1 kHz stereo for stem separation, else 32 kHz mono). The WAV is removed
// when the analysis ends.
func (r *analysis) engineAudio(ctx context.Context) (string, error) {
	if r.audio != "" {
		return r.audio, nil
	}
	if engineReads[strings.ToLower(filepath.Ext(r.input))] {
		r.audio = r.input
		return r.audio, nil
	}
	ffmpeg, err := r.job.Tool("ffmpeg")
	if err != nil {
		return "", err
	}
	out := filepath.Join(r.folder, fmt.Sprintf("audio-s%d.wav", b2i(r.o.Stems)))
	rate, ch := "32000", "1"
	if r.o.Stems {
		rate, ch = "44100", "2"
	}
	args := []string{"-hide_banner", "-nostdin", "-y", "-i", r.input, "-vn", "-map", "0:a:0", "-ac", ch, "-ar", rate, "-c:a", "pcm_s16le", out}
	if err := runFFmpeg(ctx, ffmpeg, args); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", core.Errorf(core.CodeToolFailed, "Couldn't read the sound of this file").WithHint("Does it have an audio track?").WithCause(err)
	}
	r.created = append(r.created, out)
	r.audio = out
	return out, nil
}

func (r *analysis) audioJSON() string {
	return filepath.Join(r.folder, fmt.Sprintf("s%d.json", b2i(r.o.Stems)))
}
func (r *analysis) audioBin() string { return strings.TrimSuffix(r.audioJSON(), ".json") + ".bin" }
func (r *analysis) instrumental() string {
	return filepath.Join(r.folder, instrumentalName)
}
func (r *analysis) textPath() string {
	return filepath.Join(r.folder, fmt.Sprintf("t-%s-s%d-%s.json", TextKey(r.o), b2i(r.o.Stems), MoodCode(r.o)))
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (r *analysis) remember(p string) { r.created = append(r.created, p) }

func (r *analysis) cleanup() {
	for _, p := range r.created {
		_ = os.Remove(p)
	}
}

// audioReady reports whether the engine's features for this stems setting exist.
func (r *analysis) audioReady() bool {
	if !fileOK(r.audioBin()) {
		return false
	}
	_, err := readFeatureInfo(r.audioJSON())
	return err == nil
}

func readTextFile(p string) (*textFile, bool) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	var t textFile
	if json.Unmarshal(b, &t) != nil || t.Version != 1 {
		return nil, false
	}
	return &t, true
}

// analyze runs (or reuses) the analysis of input (SPEC.md §5.1).
func (a *Analyzer) analyze(ctx context.Context, job *core.JobContext, input string, o AnalyzeOptions) (ref AnalysisRef, err error) {
	if o.Words == "" {
		o.Words = WordsNone
	}
	if o.Words == WordsNone {
		o.Mood, o.DeepRead = false, false
	}
	if err := validateAnalyze(o); err != nil {
		return AnalysisRef{}, err
	}
	fileKey, err := FileKey(input)
	if err != nil {
		return AnalysisRef{}, core.Errorf(core.CodeNotFound, "This file doesn't exist any more").WithHint(input).WithCause(err)
	}
	key := AnalysisKey(fileKey, o)
	saveStems := o.Stems && o.SaveStems
	if cached, ok := a.Lookup(key); ok && !saveStems {
		job.Progress(1, "Using the saved analysis")
		return cached, nil
	}
	plan, err := planWords(o)
	if err != nil {
		return AnalysisRef{}, err
	}
	r := &analysis{a: a, job: job, o: o, input: input, folder: filepath.Join(a.cacheDir, fileKey)}
	r.stems = filepath.Join(r.folder, "stems")
	if err := os.MkdirAll(r.folder, 0o755); err != nil {
		return AnalysisRef{}, core.Errorf(core.CodeInternal, "Couldn't create the analysis folder").WithCause(err)
	}
	now := nowFunc()
	_ = os.Chtimes(r.folder, now, now)
	defer func() {
		_ = os.RemoveAll(r.stems)
		if r.audio != "" && r.audio != r.input {
			_ = os.Remove(r.audio) // the extracted WAV is only needed during the run
		}
		if err != nil {
			r.cleanup()
		}
	}()
	fail := func(e error) (AnalysisRef, error) {
		if cerr := ctx.Err(); cerr != nil {
			return AnalysisRef{}, cerr
		}
		return AnalysisRef{}, e
	}

	haveAudio := r.audioReady()
	haveInstr := !o.Stems || fileOK(r.instrumental())
	var cachedText *textFile
	if o.Words != WordsNone {
		cachedText, _ = readTextFile(r.textPath())
	}
	needWords := o.Words != WordsNone && cachedText == nil
	needStems := o.Stems && (!haveAudio || !haveInstr || saveStems || (needWords && plan.transcribe))
	moodReader := false
	if needWords && o.Mood && a.MoodModel != nil {
		_, _, moodReader = a.MoodModel()
	}
	if needStems || !haveAudio || (needWords && (plan.transcribe || moodReader)) {
		if _, err := job.Tool(sidecar.DepID); err != nil {
			return AnalysisRef{}, err
		}
	}

	// 2. Stems.
	if needStems {
		job.Progress(0, "Separating the instruments")
		if err := r.separate(ctx, job.Scoped(0, 0.45)); err != nil {
			return fail(err)
		}
	}
	if err := ctx.Err(); err != nil {
		return AnalysisRef{}, err
	}

	// 3. Features.
	if !haveAudio {
		from, to := 0.0, 0.4
		if o.Stems {
			from, to = 0.45, 0.6
		}
		job.Progress(from, "Analysing the song")
		if err := r.features(ctx, job.Scoped(from, to)); err != nil {
			return fail(err)
		}
	}
	info, err := readFeatureInfo(r.audioJSON())
	if err != nil {
		return AnalysisRef{}, core.Errorf(core.CodeToolFailed, "The AI engine didn't write the song features").WithCause(err)
	}
	if err := ctx.Err(); err != nil {
		return AnalysisRef{}, err
	}

	// 4. Instrumental, and the saved stems.
	if o.Stems && !haveInstr {
		job.Progress(0.6, "Mixing the instrumental")
		if err := r.mixInstrumental(ctx); err != nil {
			return fail(err)
		}
	}
	if saveStems {
		if err := r.saveStems(); err != nil {
			return fail(err)
		}
	}
	if err := ctx.Err(); err != nil {
		return AnalysisRef{}, err
	}

	// 5-8. Words, emphasis, mood, the text file.
	ref = AnalysisRef{Key: key, AudioJSON: r.audioJSON(), FeaturesPath: r.audioBin()}
	if o.Stems {
		ref.Instrumental = r.instrumental()
	}
	var tf *textFile
	if o.Words != WordsNone {
		if cachedText != nil {
			tf = cachedText
			job.Progress(1, "Using the saved words")
		} else {
			tf, err = r.words(ctx, plan, info)
			if err != nil {
				return fail(err)
			}
			if err := writeJSONAtomic(r.textPath(), tf); err != nil {
				return AnalysisRef{}, core.Errorf(core.CodeInternal, "Couldn't save the words").WithCause(err)
			}
			r.remember(r.textPath())
		}
		ref.TextJSON = r.textPath()
	}
	ref.Summary = summarise(info, o, tf)
	if err := a.WriteRef(ref); err != nil {
		return AnalysisRef{}, core.Errorf(core.CodeInternal, "Couldn't save the analysis").WithCause(err)
	}
	job.Progress(1, "Analysis ready")
	return ref, nil
}

func summarise(info *featureInfo, o AnalyzeOptions, tf *textFile) AnalysisSummary {
	s := AnalysisSummary{DurationMs: info.DurationMs, Tempo: info.Tempo, Key: info.Key.Name,
		Sections: []string{}, HasStems: o.Stems, MoodSource: "music", Warnings: []string{}}
	for _, sec := range info.Sections {
		s.Sections = append(s.Sections, sec.Label)
	}
	if tf != nil {
		s.Language, s.Lines = tf.Language, len(tf.Lines)
		s.HasWords = len(tf.Lines) > 0
		for _, l := range tf.Lines {
			if l.Meaning != nil {
				s.HasMeaning = true
				break
			}
		}
		if tf.MoodSource != "" {
			s.MoodSource = tf.MoodSource
		}
		s.Warnings = append(s.Warnings, tf.Warnings...)
	}
	return s
}

func writeJSONAtomic(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// separate runs stems.separate (four-fast, FLAC) into <folder>/stems.
func (r *analysis) separate(ctx context.Context, job *core.JobContext) error {
	_ = os.RemoveAll(r.stems)
	if err := os.MkdirAll(r.stems, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the stems folder").WithCause(err)
	}
	audio, err := r.engineAudio(ctx)
	if err != nil {
		return err
	}
	params := map[string]any{
		"input": audio, "outputDir": r.stems, "model": "htdemucs.yaml", // the four-fast preset
		"outputFormat": "flac", "baseName": core.StemName(r.input),
	}
	raw, err := r.a.sc.Call(ctx, "stems.separate", params, engineEvents(job))
	if err != nil {
		return err
	}
	var res struct {
		Stems []struct {
			Name string `json:"name"`
			Path string `json:"path"`
		} `json:"stems"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	r.paths = map[string]string{}
	for _, s := range res.Stems {
		if fileOK(s.Path) {
			r.paths[strings.ToLower(s.Name)] = s.Path
		}
	}
	for _, n := range []string{"drums", "bass", "vocals", "other"} {
		if r.paths[n] == "" {
			return core.Errorf(core.CodeToolFailed, "The AI engine didn't produce all four stems")
		}
	}
	return nil
}

// features runs viz.analyze.
func (r *analysis) features(ctx context.Context, job *core.JobContext) error {
	var stems any
	if r.o.Stems {
		stems = map[string]string{"drums": r.paths["drums"], "bass": r.paths["bass"], "vocals": r.paths["vocals"], "other": r.paths["other"]}
	}
	name := fmt.Sprintf("s%d", b2i(r.o.Stems))
	audio, err := r.engineAudio(ctx)
	if err != nil {
		return err
	}
	params := map[string]any{"path": audio, "stems": stems, "outDir": r.folder, "name": name}
	r.remember(r.audioJSON())
	r.remember(r.audioBin())
	if _, err := r.a.sc.Call(ctx, "viz.analyze", params, engineEvents(job)); err != nil {
		return err
	}
	if !r.audioReady() {
		return core.Errorf(core.CodeToolFailed, "The AI engine didn't write the song features")
	}
	// Success: the files are the cache now.
	r.created = slices.DeleteFunc(r.created, func(p string) bool { return p == r.audioJSON() || p == r.audioBin() })
	return nil
}

func (r *analysis) mixInstrumental(ctx context.Context) error {
	ffmpeg, err := r.job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	tmp := filepath.Join(r.folder, "instrumental.tmp.flac")
	r.remember(tmp)
	if err := runFFmpeg(ctx, ffmpeg, instrumentalArgs(r.paths["drums"], r.paths["bass"], r.paths["other"], tmp)); err != nil {
		return err
	}
	if !fileOK(tmp) {
		return core.Errorf(core.CodeToolFailed, "Couldn't mix the instrumental")
	}
	if err := os.Rename(tmp, r.instrumental()); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the instrumental").WithCause(err)
	}
	r.created = slices.DeleteFunc(r.created, func(p string) bool { return p == tmp })
	return nil
}

// saveStems copies the four FLACs into the Library as <OutputDir>/Stems/<base>/<base> - <Stem>.flac
// (the Stems tool's names), before the cache copies are deleted (SPEC.md §9.7).
func (r *analysis) saveStems() error {
	base := core.StemName(r.input)
	dir := filepath.Join(r.job.OutputDir, "Stems", base)
	for i := 2; ; i++ {
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			break
		}
		dir = filepath.Join(r.job.OutputDir, "Stems", fmt.Sprintf("%s (%d)", base, i))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the stems folder").WithCause(err)
	}
	for _, n := range []string{"Vocals", "Drums", "Bass", "Other"} {
		src := r.paths[strings.ToLower(n)]
		dst := filepath.Join(dir, fmt.Sprintf("%s - %s.flac", base, n))
		if err := copyFile(src, dst); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't save the %s stem", strings.ToLower(n)).WithCause(err)
		}
		var err error
		if r.a.LibraryOutput != nil {
			err = r.a.LibraryOutput(r.job, dst)
		} else {
			_, err = r.job.Output(dst)
		}
		if err != nil {
			return fmt.Errorf("registering the %s stem: %w", strings.ToLower(n), err)
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}

// ---- words ----------------------------------------------------------------

type whisperDoc struct {
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

func secMs(s float64) int64 { return int64(s*1000 + 0.5) }

func parseWhisper(data []byte) (segs []lyrics.Segment, language string, err error) {
	var doc whisperDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, "", fmt.Errorf("decoding the transcription: %w", err)
	}
	for _, s := range doc.Segments {
		seg := lyrics.Segment{StartMs: secMs(s.Start), EndMs: secMs(s.End), Text: strings.TrimSpace(s.Text)}
		for _, w := range s.Words {
			seg.Words = append(seg.Words, lyrics.Word{StartMs: secMs(w.Start), EndMs: secMs(w.End), Text: strings.TrimSpace(w.Word)})
		}
		segs = append(segs, seg)
	}
	return segs, doc.Language, nil
}

func flattenWords(segs []lyrics.Segment) []lyrics.Word {
	var out []lyrics.Word
	for _, s := range segs {
		if len(s.Words) > 0 {
			out = append(out, s.Words...)
			continue
		}
		ln := lyrics.Line{StartMs: s.StartMs, EndMs: s.EndMs, Text: s.Text}
		lyrics.SpreadWords(&ln)
		out = append(out, ln.Words...)
	}
	return out
}

// transcribe runs transcribe.run on src (the vocals stem, or the input).
func (r *analysis) transcribe(ctx context.Context, job *core.JobContext, src string) ([]lyrics.Segment, string, error) {
	var lang any
	if r.o.Language != "" {
		lang = r.o.Language
	}
	params := map[string]any{
		"input": src, "outputDir": r.job.TempDir, "baseName": "lyrics",
		"model": whisperRepo, "modelDir": filepath.Join(r.a.modelsDir, "whisper", whisperModel),
		"language": lang, "task": "transcribe", "formats": []string{"json"}, "vad": true,
	}
	raw, err := r.a.sc.Call(ctx, "transcribe.run", params, engineEvents(job))
	if err != nil {
		return nil, "", err
	}
	var res struct {
		Outputs []string `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, "", core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	for _, p := range res.Outputs {
		if !strings.EqualFold(filepath.Ext(p), ".json") {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, "", fmt.Errorf("reading the transcription: %w", err)
		}
		segs, lang, err := parseWhisper(data)
		if err != nil {
			return nil, "", core.Errorf(core.CodeInternal, "The AI engine returned an unreadable transcription").WithCause(err)
		}
		return segs, lang, nil
	}
	return nil, "", core.Errorf(core.CodeToolFailed, "The AI engine didn't write word timings")
}

func toTextLines(in []lyrics.Line) []textLine {
	out := make([]textLine, 0, len(in))
	for _, l := range in {
		l.EndMs = max(l.EndMs, l.StartMs)
		if len(l.Words) == 0 {
			lyrics.SpreadWords(&l)
		}
		tl := textLine{StartMs: l.StartMs, EndMs: l.EndMs, Text: l.Text, Words: make([]textWord, 0, len(l.Words))}
		for _, w := range l.Words {
			tl.Words = append(tl.Words, textWord{StartMs: w.StartMs, EndMs: max(w.EndMs, w.StartMs), Text: w.Text})
		}
		out = append(out, tl)
	}
	return out
}

// words runs steps 5-8: the words, emphasis, mood and the text file contents.
func (r *analysis) words(ctx context.Context, plan wordsPlan, info *featureInfo) (*textFile, error) {
	tf := &textFile{Version: 1, Source: string(plan.source), Language: r.o.Language, Matched: 1,
		MoodSource: "music", Warnings: []string{}}
	warn := func(w string) {
		if !slices.Contains(tf.Warnings, w) {
			tf.Warnings = append(tf.Warnings, w)
		}
	}

	// 5. Words.
	r.job.Progress(0.6, "Reading the words")
	lines := plan.lines
	if plan.transcribe {
		src, err := r.engineAudio(ctx)
		if err != nil {
			return nil, err
		}
		if r.o.Stems {
			src = r.paths["vocals"]
		}
		segs, lang, err := r.transcribe(ctx, r.job.Scoped(0.6, 0.85), src)
		if err != nil {
			return nil, err
		}
		if lang != "" {
			tf.Language = lang
		}
		if plan.text != "" {
			var matched float64
			lines, matched = lyrics.Align(plan.text, flattenWords(segs))
			tf.Matched = matched
			if matched < 0.4 {
				warn(warnWeakAlignment)
			}
		} else {
			lines = lyrics.DetectLines(segs)
			if len(lines) == 0 {
				warn(warnNoWords)
			}
		}
	}
	tf.Lines = toTextLines(lines)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r.job.Progress(0.85, "Finding the emphasis")

	// 6. Emphasis from the loudness.
	chName := "mix.presence"
	if r.o.Stems {
		chName = "vocals.level"
	}
	applyEmphasis(tf.Lines, info.channel(r.audioBin(), chName), info.FPS, info.Events.Held)

	// 7. Mood.
	if len(tf.Lines) > 0 && (r.o.Mood || r.o.DeepRead) {
		if err := r.mood(ctx, tf, warn); err != nil {
			return nil, err
		}
	}

	// 8. Keyframes.
	tf.Mood = buildMood(info, newMusicMood(info, r.audioBin()), tf.Lines)
	if tf.Lines == nil {
		tf.Lines = []textLine{}
	}
	return tf, nil
}

// mood reads the meaning of tf's lines (the reader, then the chat) and sets
// tf.MoodSource. Failures other than cancellation become warnings.
func (r *analysis) mood(ctx context.Context, tf *textFile, warn func(string)) error {
	a := r.a
	n := len(tf.Lines)
	reader := make([]*meaning, n)
	haveReader, haveChat, readerTried := false, false, false
	lo := 0.85

	if r.o.Mood {
		model, tok, ok := "", "", false
		if a.MoodModel != nil {
			model, tok, ok = a.MoodModel()
		}
		readerTried = ok
		if ok {
			r.job.Progress(lo, "Reading the mood of the words")
			ms, err := a.readMood(ctx, r.job.Scoped(lo, 0.92), tf.Lines, model, tok)
			switch {
			case err == nil:
				haveReader = true
				for i := range ms {
					reader[i] = &ms[i]
				}
			case ctx.Err() != nil:
				return ctx.Err()
			default:
				r.job.Logf("mood reader failed: %v", err)
				warn("The mood reader failed: mood comes from the music only")
			}
		}
	}

	var chat []chatReading
	if r.o.DeepRead {
		switch {
		case a.textgen == nil:
			warn("Local Chat isn't available: no deeper reading")
		default:
			if _, err := a.textgen.Ready(); err != nil {
				warn("Local Chat isn't ready: download a model in Local Chat first")
			} else {
				rs, err := a.deepRead(ctx, r.job.Scoped(0.92, 1), tf.Lines)
				switch {
				case err == nil:
					chat, haveChat = rs, true
				case ctx.Err() != nil:
					return ctx.Err()
				default:
					r.job.Logf("deeper reading failed: %v", err)
					warn("The deeper reading failed: using the mood reader only")
				}
			}
		}
	}

	switch {
	case haveReader && haveChat:
		tf.MoodSource = "reader+chat"
	case haveReader:
		tf.MoodSource = "reader"
	case haveChat:
		tf.MoodSource = "chat"
	}
	if r.o.Mood && !haveReader && !readerTried {
		if haveChat {
			warn(warnNoReaderChat)
		} else {
			warn(warnNoReader)
		}
	}
	if !haveReader && !haveChat {
		return nil
	}
	for i := range tf.Lines {
		var cr chatReading
		if haveChat {
			cr = chat[i]
			emphasiseWords(&tf.Lines[i], cr.emphasis)
		}
		m := mergeReading(reader[i], cr)
		tf.Lines[i].Meaning = &m
	}
	return nil
}
