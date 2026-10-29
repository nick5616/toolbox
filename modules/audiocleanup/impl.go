package audiocleanup

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

//go:embed rnnoise/std.rnnn
var rnnoiseModel []byte

// previewMaxAge is how long cleanup previews are kept (SPEC.md §6.2).
const previewMaxAge = 24 * time.Hour

func validateOptions(o Options) error {
	fields := map[string]string{}
	switch o.Hum {
	case HumOff, HumAuto, Hum50, Hum60:
	default:
		fields["hum"] = "Choose auto, 50 Hz, 60 Hz or off"
	}
	switch o.Denoise {
	case DenoiseOff, DenoiseLight, DenoiseStrong, DenoiseVoice:
	default:
		fields["denoise"] = "Choose off, light, strong or voice isolation"
	}
	switch o.Loudness {
	case LoudnessOff, LoudnessPodcast, LoudnessStreaming, LoudnessBroadcast:
	default:
		fields["loudness"] = "Choose a loudness target"
	}
	switch o.Format {
	case FormatSame, FormatWAV, FormatFLAC, FormatMP3, FormatM4A:
	default:
		fields["format"] = "Choose an output format"
	}
	if o.PreviewStartMs < 0 {
		fields["previewStartMs"] = "The preview start can't be negative"
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
	return validateOptions(o)
}

// runner holds what one job's steps share.
type runner struct {
	m       *Module
	job     *core.JobContext
	o       Options
	ffmpeg  string
	ffprobe string
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
		return core.ValidationError("Add at least one file", map[string]string{"inputs": "Add at least one file"})
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	if o.Denoise == DenoiseVoice {
		if _, err := job.Tool(sidecar.DepID); err != nil {
			return err
		}
		if !m.modelPresent(PresetVoice) {
			return core.Errorf(core.CodeDependencyMissing, "Voice isolation needs its model").
				WithHint("Install the voice isolation model from Tool packs (Speech), or pick another noise reduction")
		}
	}
	r := &runner{m: m, job: job, o: o, ffmpeg: ffmpeg, ffprobe: ffprobe}
	if o.Preview {
		return r.preview(ctx, job.Inputs[0])
	}

	var res Result
	res.Files = []FileResult{}
	n := len(job.Inputs)
	for i, in := range job.Inputs {
		sub := *r
		sub.job = job.Scoped(float64(i)/float64(n), float64(i+1)/float64(n))
		fr, err := sub.cleanFile(ctx, in, i)
		if err != nil {
			return err
		}
		res.Files = append(res.Files, fr)
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	if len(res.Files) == 1 {
		job.Progress(1, summary(res.Files[0].LUFSBefore, res.Files[0].LUFSAfter, res.Files[0].HumHz))
	} else {
		job.Progress(1, fmt.Sprintf("Cleaned %d files", len(res.Files)))
	}
	return nil
}

// summary is the one-line outcome, e.g. "-27.4 → -16.0 LUFS · hum 50 Hz removed".
func summary(before, after float64, humHz int) string {
	s := fmt.Sprintf("%.1f → %.1f LUFS", before, after)
	if humHz > 0 {
		s += fmt.Sprintf(" · hum %d Hz removed", humHz)
	}
	return s
}

// fileInfo probes input and checks it has audio.
func (r *runner) fileInfo(ctx context.Context, input string) (media.Info, error) {
	info, err := media.Probe(ctx, r.ffprobe, input)
	if err != nil {
		return info, err
	}
	if len(info.Audio) == 0 {
		return info, core.ValidationError("This file has no audio track", map[string]string{"inputs": filepath.Base(input) + " has no audio"})
	}
	return info, nil
}

// cleanFile processes one input into the library.
func (r *runner) cleanFile(ctx context.Context, input string, idx int) (FileResult, error) {
	r.job.SetTitle(filepath.Base(input))
	info, err := r.fileInfo(ctx, input)
	if err != nil {
		return FileResult{}, err
	}
	tmp := filepath.Join(r.job.TempDir, strconv.Itoa(idx))
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return FileResult{}, fmt.Errorf("create work dir: %w", err)
	}
	ext := filepath.Ext(input)
	video := info.Video != nil
	enc := audioEncoding(ext, r.o.Format)
	if video {
		enc = videoEncoding(ext)
	}

	humHz, err := r.humHz(ctx, r.job.Scoped(0, 0.05), input, info, tmp)
	if err != nil {
		return FileResult{}, err
	}
	out := filepath.Join(tmp, "out"+enc.Ext)
	before, after, err := r.clean(ctx, cleanReq{
		in: input, info: info, humHz: humHz, enc: enc, out: out, video: video, tmp: tmp,
		durSec: float64(info.DurationMs) / 1000,
	}, 0.05, 1)
	if err != nil {
		return FileResult{}, err
	}
	final := core.UniquePath(r.job.OutputDir, core.StemName(input)+" (clean)", enc.Ext)
	if err := moveFile(out, final); err != nil {
		return FileResult{}, core.Errorf(core.CodeToolFailed, "Couldn't save the cleaned file").WithCause(err)
	}
	if _, err := r.job.Output(final); err != nil {
		return FileResult{}, fmt.Errorf("register output: %w", err)
	}
	return FileResult{Input: input, Output: final, LUFSBefore: before, LUFSAfter: after, HumHz: humHz}, nil
}

// preview writes the 10 s original and cleaned excerpts into the preview cache.
func (r *runner) preview(ctx context.Context, input string) error {
	if r.m.previewDir == "" {
		return core.Errorf(core.CodeInternal, "Previews aren't available")
	}
	r.job.SetTitle("Preview — " + filepath.Base(input))
	info, err := r.fileInfo(ctx, input)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(r.m.previewDir, 0o755); err != nil {
		return fmt.Errorf("create preview dir: %w", err)
	}
	tmp := filepath.Join(r.job.TempDir, "preview")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return fmt.Errorf("create work dir: %w", err)
	}
	humHz, err := r.humHz(ctx, r.job.Scoped(0, 0.05), input, info, tmp)
	if err != nil {
		return err
	}
	start, length := previewSpan(r.o.PreviewStartMs, info.DurationMs)
	excerpt := filepath.Join(tmp, "excerpt.wav")
	if err := r.ff(ctx, r.job.Scoped(0.05, 0.1), tmp, length, "Cutting the excerpt", nil, []string{
		"-ss", num(start), "-t", num(length), "-i", input, "-vn", "-map", "0:a:0", "-c:a", "pcm_f32le", excerpt,
	}); err != nil {
		return err
	}
	pa, pb := previewNames(r.m.previewDir, r.job.ID)
	aTmp := filepath.Join(tmp, "a.wav")
	if err := r.ff(ctx, nil, tmp, length, "Preparing the original", nil, []string{
		"-i", excerpt, "-map", "0:a:0", "-c:a", "pcm_s16le", aTmp,
	}); err != nil {
		return err
	}
	exInfo := info
	exInfo.DurationMs = int64(length * 1000)
	exInfo.Video = nil
	bTmp := filepath.Join(tmp, "b.wav")
	before, after, err := r.clean(ctx, cleanReq{
		in: excerpt, info: exInfo, humHz: humHz, enc: previewEncoding(), out: bTmp, tmp: tmp, durSec: length,
	}, 0.1, 1)
	if err != nil {
		return err
	}
	if err := moveFile(aTmp, pa); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the preview").WithCause(err)
	}
	if err := moveFile(bTmp, pb); err != nil {
		_ = os.Remove(pa)
		return core.Errorf(core.CodeToolFailed, "Couldn't save the preview").WithCause(err)
	}
	res := Result{Files: []FileResult{}, PreviewOriginal: pa, PreviewCleaned: pb, LUFSBefore: before, LUFSAfter: after, HumHz: humHz}
	if err := r.job.SetResult(res); err != nil {
		return err
	}
	r.job.Progress(1, summary(before, after, humHz))
	return nil
}

// humHz resolves the Hum option to a mains frequency (0 = none).
func (r *runner) humHz(ctx context.Context, sc *core.JobContext, input string, info media.Info, tmp string) (int, error) {
	switch r.o.Hum {
	case Hum50:
		return 50, nil
	case Hum60:
		return 60, nil
	case HumAuto:
	default:
		return 0, nil
	}
	sc.Progress(core.IndeterminateProgress, "Listening for hum")
	args := []string{"-vn", "-map", "0:a:0", "-ac", "1", "-ar", strconv.Itoa(humSampleRate), "-f", "s16le"}
	pre := []string{}
	if secs := float64(info.DurationMs) / 1000; secs > humDetectSeconds {
		pre = append(pre, "-ss", num(math.Floor(secs/2-humDetectSeconds/2)))
	}
	pre = append(pre, "-t", strconv.Itoa(humDetectSeconds), "-i", input)
	raw := filepath.Join(tmp, "hum.raw")
	if err := r.ff(ctx, nil, tmp, 0, "", nil, append(append(pre, args...), raw)); err != nil {
		if ctx.Err() != nil {
			return 0, err
		}
		r.job.Logf("hum detection skipped: %v", err)
		return 0, nil
	}
	b, err := os.ReadFile(raw)
	_ = os.Remove(raw)
	if err != nil {
		return 0, nil
	}
	return detectHum(decodeS16LE(b)), nil
}

// cleanReq is one source → one encoded output.
type cleanReq struct {
	in     string
	info   media.Info
	humHz  int
	enc    encoding
	out    string
	video  bool // keep in's video stream (-c:v copy)
	tmp    string
	durSec float64
}

// clean runs the chain on req.in and writes req.out, mapping its progress to
// [from, to] of r.job. It returns the loudness before and after.
func (r *runner) clean(ctx context.Context, req cleanReq, from, to float64) (before, after float64, err error) {
	voice := r.o.Denoise == DenoiseVoice
	target, loud := targetFor(r.o.Loudness)

	// Progress weights.
	w := []float64{0.08}
	if voice {
		w = append(w, 0.08, 0.5)
	}
	if loud {
		w = append(w, 0.12, 0.22)
	} else {
		w = append(w, 0.22)
	}
	w = append(w, 0.08) // the final loudness measure (loudness off) or slack
	var sum float64
	for _, x := range w {
		sum += x
	}
	pos := from
	next := func() *core.JobContext {
		x := w[0]
		w = w[1:]
		a := pos
		pos += (to - from) * x / sum
		return r.job.Scoped(a, pos)
	}

	// Loudness before.
	before, err = r.measure(ctx, next(), req.in, req.tmp, req.durSec)
	if err != nil {
		return 0, 0, err
	}

	if r.o.Denoise == DenoiseStrong {
		if err := os.WriteFile(filepath.Join(req.tmp, rnnoiseFile), rnnoiseModel, 0o600); err != nil {
			return 0, 0, fmt.Errorf("write the noise model: %w", err)
		}
	}

	src := req.in
	var chain []string
	if voice {
		stage := filepath.Join(req.tmp, "stage.wav")
		args := []string{"-i", req.in, "-vn", "-map", "0:a:0"}
		if f := join(preFilters(r.o, req.humHz)); f != "" {
			args = append(args, "-af", f)
		}
		args = append(args, "-ar", "48000", "-c:a", "pcm_f32le", stage)
		if err := r.ff(ctx, next(), req.tmp, req.durSec, "Preparing audio", nil, args); err != nil {
			return 0, 0, err
		}
		dn := filepath.Join(req.tmp, "voice.wav")
		if err := r.isolate(ctx, next(), stage, dn); err != nil {
			return 0, 0, err
		}
		_ = os.Remove(stage)
		src = dn
	} else {
		chain = inlineFilters(r.o, req.humHz)
	}

	// Input and mapping for the final encode.
	var in, mapping []string
	switch {
	case req.video && src != req.in:
		in = []string{"-i", req.in, "-i", src}
		mapping = []string{"-map", "0:v", "-map", "1:a:0"}
	case req.video:
		in = []string{"-i", req.in}
		mapping = []string{"-map", "0:v", "-map", "0:a:0"}
	default:
		in = []string{"-i", src}
		mapping = []string{"-vn", "-map", "0:a:0"}
	}
	encArgs := req.enc.Args
	srcRate := 0
	if len(req.info.Audio) > 0 {
		srcRate = req.info.Audio[0].SampleRate
	}

	finishScoped := func(sc *core.JobContext, af string, stderr *[]string) error {
		args := append([]string{}, in...)
		args = append(args, mapping...)
		if af != "" {
			args = append(args, "-af", af)
		}
		args = append(args, encArgs...)
		args = append(args, req.out)
		return r.ff(ctx, sc, req.tmp, req.durSec, "Encoding", stderr, args)
	}

	if !loud {
		af := join(chain)
		if voice && srcRate > 0 && srcRate != 48000 {
			af = join(append(chain, fmt.Sprintf("aresample=%d", srcRate)))
		}
		if err := finishScoped(next(), af, nil); err != nil {
			return 0, 0, err
		}
		after, err = r.measure(ctx, next(), req.out, req.tmp, req.durSec)
		return before, after, err
	}

	// Two-pass loudnorm.
	var tail []string
	p1 := join(append(append([]string{}, chain...), loudnormPass1(target)))
	if err := r.ff(ctx, next(), req.tmp, req.durSec, "Measuring loudness", &tail, []string{
		"-i", src, "-map", "0:a:0", "-af", p1, "-f", "null", "-",
	}); err != nil {
		return 0, 0, err
	}
	stats, err := parseLoudnorm(tail)
	if err != nil {
		var ae *core.AppError
		if errors.As(err, &ae) {
			return 0, 0, err
		}
		return 0, 0, core.Errorf(core.CodeToolFailed, "Couldn't measure this file's loudness").WithCause(err)
	}
	p2 := join(append(append([]string{}, chain...), loudnormPass2(target, stats, outRate(srcRate))))
	var tail2 []string
	if err := finishScoped(next(), p2, &tail2); err != nil {
		return 0, 0, err
	}
	after = target.I
	if st2, err := parseLoudnorm(tail2); err == nil {
		if v, err := strconv.ParseFloat(st2.OutputI, 64); err == nil {
			after = v
		}
	}
	return before, after, nil
}

// measure returns the integrated loudness of a file's first audio stream
// (-70 when silent).
func (r *runner) measure(ctx context.Context, sc *core.JobContext, path, tmp string, durSec float64) (float64, error) {
	var tail []string
	if err := r.ff(ctx, sc, tmp, durSec, "Measuring loudness", &tail, []string{
		"-i", path, "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-",
	}); err != nil {
		return 0, err
	}
	v, ok := parseEBU128(tail)
	if !ok {
		return -70, nil
	}
	return v, nil
}

// isolate runs DeepFilterNet3 on the engine: stage (48 kHz f32 WAV) → dst.
func (r *runner) isolate(ctx context.Context, sc *core.JobContext, stage, dst string) error {
	if _, err := r.job.Tool(sidecar.DepID); err != nil {
		return err
	}
	_, err := r.m.sc.Call(ctx, "denoise.dfn3", map[string]any{
		"path": stage, "out": dst, "modelDir": r.m.voiceModelDir(),
	}, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			sc.Progress(ev.Pct, ev.Msg)
		case "log":
			stream := core.StreamStdout
			if ev.Level == "warning" || ev.Level == "error" {
				stream = core.StreamStderr
			}
			r.job.Log(stream, ev.Line)
		}
	})
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err != nil {
		return core.Errorf(core.CodeToolFailed, "Voice isolation produced no audio").WithCause(err)
	}
	return nil
}

// ff runs FFmpeg with dir as its working directory. sc may be nil (no
// progress). When tail is non-nil it receives FFmpeg's last stderr lines.
func (r *runner) ff(ctx context.Context, sc *core.JobContext, dir string, durSec float64, label string, tail *[]string, args []string) error {
	full := []string{"-hide_banner", "-nostdin", "-nostats", "-y", "-progress", "pipe:1"}
	full = append(full, args...)
	tracker := &media.ProgressTracker{Duration: durSec, Label: label}
	var mu sync.Mutex
	res, err := proc.Run(ctx, proc.Spec{
		Path: r.ffmpeg, Args: full, Dir: dir,
		OnStdout: func(l string) {
			if sc == nil || label == "" {
				return
			}
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				sc.Progress(pct, msg)
			}
		},
	})
	if tail != nil {
		*tail = res.StderrTail
	}
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("audio cleanup cancelled: %w", ctx.Err())
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return core.Errorf(core.CodeToolFailed, "FFmpeg couldn't process this audio").WithHint(hint).WithCause(err)
	}
	return nil
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
	_ = os.Remove(src)
	return nil
}

// prunePreviews deletes excerpts older than a day.
func (m *Module) prunePreviews() { m.removePreviews(time.Now().Add(-previewMaxAge)) }

// prunePreviewsAll deletes every excerpt (the view calls it on unmount).
func (m *Module) prunePreviewsAll() { m.removePreviews(time.Time{}) }

// removePreviews deletes preview WAVs modified before cutoff (zero = all).
func (m *Module) removePreviews(cutoff time.Time) {
	if m.previewDir == "" {
		return
	}
	entries, err := os.ReadDir(m.previewDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !(strings.HasSuffix(name, "-a.wav") || strings.HasSuffix(name, "-b.wav")) {
			continue
		}
		if !cutoff.IsZero() {
			fi, err := e.Info()
			if err != nil || !fi.ModTime().Before(cutoff) {
				continue
			}
		}
		_ = os.Remove(filepath.Join(m.previewDir, name))
	}
}
