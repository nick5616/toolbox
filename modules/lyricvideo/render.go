package lyricvideo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

const (
	previewMs = 10_000
	fps       = 30
)

// normalize fills defaults for empty look fields and fixes the sheet's
// order, so every later step can rely on them.
func normalize(o Options) Options {
	d := DefaultLook()
	l := &o.Look
	if l.Background == "" {
		l.Background = d.Background
	}
	if l.Color1 == "" {
		l.Color1 = d.Color1
	}
	if l.Color2 == "" {
		l.Color2 = d.Color2
	}
	if l.Font == "" {
		l.Font = d.Font
	}
	if l.TextColor == "" {
		l.TextColor = d.TextColor
	}
	if l.HighlightColor == "" {
		l.HighlightColor = d.HighlightColor
	}
	if l.Position == "" {
		l.Position = d.Position
	}
	if l.Visualizer == "" {
		l.Visualizer = "none"
	}
	if o.Aspect == "" {
		o.Aspect = "16:9"
	}
	if o.Height == 0 {
		o.Height = 1080
	}
	if o.Audio == "" {
		o.Audio = "original"
	}
	return o
}

// renderPlan is everything the ffmpeg command line depends on.
type renderPlan struct {
	O         Options
	Lay       layout
	Audio     string // the audio input
	Cover     string // extracted cover.png ("" = none)
	BgPath    string // image/video background
	StartMs   int64  // preview window start (0 for a full render)
	DurMs     int64  // output length
	ASSName   string // relative to the working directory
	OutName   string
	BgKind    string // effective background after fallbacks
	GradColor [2]string
}

// effectiveBackground applies the "no cover art" fallback.
func effectiveBackground(look Look, hasCover bool) (kind string, fellBack bool) {
	switch look.Background {
	case "blur-cover", "cover":
		if !hasCover {
			return "gradient", true
		}
	}
	return look.Background, false
}

func secs(ms int64) string { return fmt.Sprintf("%.3f", float64(ms)/1000) }

func ffColor(hex string) string { return "0x" + strings.TrimPrefix(hex, "#") }

// fillCrop scales to cover the canvas, then crops to it.
func fillCrop(w, h int) string {
	return fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d", w, h, w, h)
}

// filterGraph builds -filter_complex and the label of the video output.
func (p renderPlan) filterGraph() (graph, out string) {
	w, h := p.Lay.W, p.Lay.H
	var parts []string
	blur := fillCrop(w, h) + ",gblur=sigma=40,eq=brightness=-0.12,setsar=1"
	cur := "bg"
	switch p.BgKind {
	case "blur-cover":
		parts = append(parts, fmt.Sprintf("[1:v]%s,fps=%d,format=yuv420p[bg]", blur, fps))
	case "cover":
		parts = append(parts,
			"[1:v]split=2[ca][cb]",
			fmt.Sprintf("[ca]%s,fps=%d,format=yuv420p[bgb]", blur, fps),
			fmt.Sprintf("[cb]scale=%d:%d:force_original_aspect_ratio=decrease[cv]", p.Lay.CoverS, p.Lay.CoverS),
			fmt.Sprintf("[bgb][cv]overlay=x=%d+(%d-w)/2:y=%d+(%d-h)/2[bg]", p.Lay.CoverX, p.Lay.CoverS, p.Lay.CoverY, p.Lay.CoverS),
		)
	case "image", "video":
		parts = append(parts, fmt.Sprintf("[1:v]%s,setsar=1,fps=%d,format=yuv420p[bg]", fillCrop(w, h), fps))
	default: // color, gradient
		parts = append(parts, "[1:v]setsar=1,format=yuv420p[bg]")
	}
	if v := p.O.Look.Visualizer; v == "wave" || v == "bars" {
		parts = append(parts, "[0:a]asplit=2[aout][avis]")
		colors := ffColor(p.O.Look.HighlightColor) + "@0.6"
		size := fmt.Sprintf("%dx%d", p.Lay.W, p.Lay.VisH)
		if v == "wave" {
			parts = append(parts, fmt.Sprintf("[avis]showwaves=s=%s:mode=cline:colors=%s:r=%d,format=yuva420p[vis]", size, colors, fps))
		} else {
			parts = append(parts, fmt.Sprintf("[avis]showfreqs=s=%s:mode=bar:fscale=log:colors=%s:rate=%d,format=yuva420p[vis]", size, colors, fps))
		}
		parts = append(parts, fmt.Sprintf("[%s][vis]overlay=x=0:y=%d[bgv]", cur, p.Lay.VisY))
		cur = "bgv"
	}
	parts = append(parts, fmt.Sprintf("[%s]ass=%s[v]", cur, p.ASSName))
	return strings.Join(parts, ";"), "[v]"
}

// audioMap is the -map value for the song audio.
func (p renderPlan) audioMap() string {
	if v := p.O.Look.Visualizer; v == "wave" || v == "bars" {
		return "[aout]"
	}
	return "0:a"
}

// args builds the ffmpeg arguments. ffmpeg runs in the temp dir, so the ASS
// file and the output are relative names.
func (p renderPlan) args() []string {
	a := []string{"-y", "-hide_banner", "-nostats", "-progress", "pipe:1"}
	if p.StartMs > 0 {
		a = append(a, "-ss", secs(p.StartMs))
	}
	a = append(a, "-t", secs(p.DurMs), "-i", p.Audio)
	d := secs(p.DurMs)
	w, h := p.Lay.W, p.Lay.H
	switch p.BgKind {
	case "color":
		a = append(a, "-f", "lavfi", "-i", fmt.Sprintf("color=c=%s:s=%dx%d:r=%d:d=%s", ffColor(p.O.Look.Color1), w, h, fps, d))
	case "gradient":
		a = append(a, "-f", "lavfi", "-i", fmt.Sprintf("gradients=s=%dx%d:c0=%s:c1=%s:x0=0:y0=0:x1=0:y1=%d:speed=0:r=%d:d=%s",
			w, h, ffColor(p.O.Look.Color1), ffColor(p.O.Look.Color2), h, fps, d))
	case "blur-cover", "cover":
		a = append(a, "-loop", "1", "-framerate", fmt.Sprint(fps), "-t", d, "-i", p.Cover)
	case "image":
		a = append(a, "-loop", "1", "-framerate", fmt.Sprint(fps), "-t", d, "-i", p.BgPath)
	case "video":
		a = append(a, "-stream_loop", "-1", "-t", d, "-i", p.BgPath)
	}
	graph, vout := p.filterGraph()
	a = append(a, "-filter_complex", graph, "-map", vout, "-map", p.audioMap(),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", fmt.Sprint(fps),
		"-c:a", "aac", "-b:a", "192k", "-shortest", "-t", d, "-movflags", "+faststart", p.OutName)
	return a
}

// writeASS writes the script for the plan into dir/p.ASSName.
func (p renderPlan) writeASS(dir string) error {
	var winEnd int64
	if p.isPreview() {
		winEnd = p.StartMs + p.DurMs
	}
	doc := buildASS(p.O, p.Lay, p.StartMs, winEnd)
	var buf bytes.Buffer
	if _, err := doc.WriteTo(&buf); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, p.ASSName), buf.Bytes(), 0o644)
}

func (p renderPlan) isPreview() bool { return p.OutName == "preview.mp4" }

// extractCover saves the song's attached picture as cover.png in dir.
func extractCover(ctx context.Context, ffmpeg, song, dir string) (string, error) {
	out := filepath.Join(dir, "cover.png")
	_, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Dir: dir,
		Args: []string{"-y", "-hide_banner", "-loglevel", "error", "-i", song, "-map", "0:v:0", "-frames:v", "1", "cover.png"},
	})
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("extract cover: %w", err)
	}
	if !fileExists(out) {
		return "", errors.New("no cover written")
	}
	return out, nil
}

// runRender is the "render" and "preview" actions.
func (m *Module) runRender(ctx context.Context, job *core.JobContext, o Options) error {
	o = normalize(o)
	song := job.Inputs[0]
	preview := o.Action == ActionPreview
	job.SetTitle(filepath.Base(song))

	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}

	audio := song
	from := 0.0
	if o.Audio == "instrumental" {
		_, inst := m.cachedStems(song)
		if inst == "" {
			var err error
			_, inst, err = m.ensureStems(ctx, job.Scoped(0, 0.3), song)
			if err != nil {
				return err
			}
		}
		audio, from = inst, 0.3
	}
	info, err := media.Probe(ctx, ffprobe, audio)
	if err != nil {
		return err
	}
	if info.DurationMs <= 0 {
		return core.Errorf(core.CodeToolFailed, "Couldn't read the length of this song")
	}

	plan := renderPlan{O: o, Audio: audio, ASSName: "subs.ass", OutName: "out.mp4", DurMs: info.DurationMs}
	if preview {
		plan.StartMs = max(0, min(o.PreviewStartMs, info.DurationMs-1000))
		plan.DurMs = min(previewMs, info.DurationMs-plan.StartMs)
		plan.OutName = "preview.mp4"
	}
	if plan.DurMs <= 0 {
		return core.ValidationError("The preview starts past the end of the song", map[string]string{"previewStartMs": "Start earlier"})
	}

	// Background.
	hasCover := false
	if o.Look.Background == "blur-cover" || o.Look.Background == "cover" {
		if info0, err := media.Probe(ctx, ffprobe, song); err == nil && info0.HasCover {
			if p, err := extractCover(ctx, ffmpeg, song, job.TempDir); err == nil {
				plan.Cover, hasCover = p, true
			} else if ctx.Err() != nil {
				return ctx.Err()
			}
		}
	}
	kind, fell := effectiveBackground(o.Look, hasCover)
	if fell {
		job.Logf("This song has no cover art, so the background is a gradient. Pick a colour, image or video background to change it.")
		job.Log(core.StreamStderr, "No cover art: using a gradient background")
	}
	plan.BgKind = kind
	plan.BgPath = o.Look.BackgroundPath
	o.Look.Background = kind // layout and ASS follow the effective background
	plan.O = o
	w, h := canvasSize(o.Aspect, o.Height)
	plan.Lay = computeLayout(o, w, h)

	if err := plan.writeASS(job.TempDir); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't write the lyrics script").WithCause(err)
	}

	scoped := job.Scoped(from, 0.97)
	tracker := &media.ProgressTracker{Duration: float64(plan.DurMs) / 1000, Label: "Rendering"}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	scoped.Progress(core.IndeterminateProgress, "Rendering…")
	_, runErr := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: plan.args(), Dir: job.TempDir,
		OnStdout: func(l string) {
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				scoped.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			job.Log(core.StreamStderr, l)
			mu.Lock()
			lastStderr = l
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("render cancelled: %w", ctxErr)
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
			msg = "ffmpeg failed"
		}
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(runErr)
	}

	tmpOut := filepath.Join(job.TempDir, plan.OutName)
	res := Result{Action: o.Action, Lines: []LyricLine{}, Outputs: []string{}}
	if preview {
		if err := os.MkdirAll(m.cacheDir, 0o755); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't create the preview folder").WithCause(err)
		}
		dst := filepath.Join(m.cacheDir, "preview-"+job.ID+".mp4")
		if err := moveFile(tmpOut, dst); err != nil {
			return core.Errorf(core.CodeToolFailed, "Couldn't save the preview").WithCause(err)
		}
		res.PreviewPath = dst
		job.Progress(1, "Preview ready")
		return job.SetResult(res)
	}

	base := core.StemName(song)
	video := core.UniquePath(job.OutputDir, base+" (lyric video)", ".mp4")
	if err := moveFile(tmpOut, video); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the video").WithCause(err)
	}
	if _, err := job.Output(video); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	res.Outputs = append(res.Outputs, video)
	if len(o.Lines) > 0 {
		lrc, err := writeLRCFile(job, o, base)
		if err != nil {
			return err
		}
		res.Outputs = append(res.Outputs, lrc)
	}
	_, inst := m.cachedStems(song)
	res.HasInstrumental = inst != ""
	job.Progress(1, "Saved "+filepath.Base(video))
	return job.SetResult(res)
}

// writeLRCFile writes <base>.lrc into the library and registers it.
func writeLRCFile(job *core.JobContext, o Options, base string) (string, error) {
	path := core.UniquePath(job.OutputDir, base, ".lrc")
	data := FormatLRC(o.Lines, o.Look.Title, o.Look.Artist)
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		return "", core.Errorf(core.CodeToolFailed, "Couldn't save the .lrc file").WithCause(err)
	}
	if _, err := job.Output(path); err != nil {
		return "", fmt.Errorf("register output: %w", err)
	}
	return path, nil
}

// runLRC is the "lrc" action: only <base>.lrc, no engine, no look.
func (m *Module) runLRC(job *core.JobContext, o Options) error {
	song := job.Inputs[0]
	job.SetTitle(filepath.Base(song))
	path, err := writeLRCFile(job, o, core.StemName(song))
	if err != nil {
		return err
	}
	job.Progress(1, "Saved "+filepath.Base(path))
	return job.SetResult(Result{Action: ActionLRC, Lines: []LyricLine{}, Outputs: []string{path}})
}

// moveFile renames src to dst, copying across volumes when needed.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Remove(src)
}
