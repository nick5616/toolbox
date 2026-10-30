package subtitles

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"toolbox/core"
	"toolbox/core/lyrics"
	"toolbox/core/media"
	"toolbox/core/viz"
)

// visualsFPS is the frame rate of a background made for an audio file.
const visualsFPS = 30

// renderShare is the part of the progress a visuals render takes.
const renderShare = 0.8

// writeASS writes <dir>/subs.ass for a w×h picture.
func writeASS(dir string, o Options, w, h int) error {
	f, err := os.Create(filepath.Join(dir, "subs.ass"))
	if err != nil {
		return fmt.Errorf("create subs.ass: %w", err)
	}
	_, werr := buildASS(o.Cues, o, w, h).WriteTo(f)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return fmt.Errorf("write subs.ass: %w", werr)
	}
	return nil
}

// canvasSize is the picture size of "make a video": the short side is
// CanvasHeight (720 or 1080, default 1080), the shape comes from Canvas
// (default 16:9). Both sides are even.
func canvasSize(o Options) (w, h int) {
	short := o.CanvasHeight
	if short != 720 {
		short = 1080
	}
	long := short * 16 / 9
	switch o.Canvas {
	case "9:16":
		return short, long
	case "1:1":
		return short, short
	}
	return long, short
}

// cueLines turns cues into timed lines for the visuals analysis; words are
// included only when the design reacts to them.
func cueLines(cues []Cue, withWords bool) []lyrics.Line {
	lines := make([]lyrics.Line, 0, len(cues))
	for _, c := range cues {
		l := lyrics.Line{StartMs: c.StartMs, EndMs: c.EndMs, Text: c.Text, Words: []lyrics.Word{}}
		if withWords {
			for _, w := range c.Words {
				l.Words = append(l.Words, lyrics.Word{StartMs: w.StartMs, EndMs: w.EndMs, Text: w.Text})
			}
		}
		lines = append(lines, l)
	}
	return lines
}

// overlaySize is the size the overlay is rendered at: the video's display
// size scaled down to at most 1440 tall, both sides even.
func overlaySize(w, h int) (int, int) {
	if h > 1440 {
		w = int(float64(w) * 1440 / float64(h))
		h = 1440
	}
	even := func(v int) int { return max(2, v&^1) }
	return even(w), even(h)
}

// snapFPS rounds a frame rate to the nearest of 24/25/30/50/60 (30 when unknown).
func snapFPS(fps float64) int {
	if fps <= 0 {
		return 30
	}
	best, bestD := 30, 1e9
	for _, c := range []int{24, 25, 30, 50, 60} {
		d := fps - float64(c)
		if d < 0 {
			d = -d
		}
		if d < bestD {
			best, bestD = c, d
		}
	}
	return best
}

// backgroundArgs makes a video of a solid colour (or a filled image) under
// the subtitles, with the input's audio. Run with Dir = the folder of subs.ass.
func backgroundArgs(o Options, w, h int, audio, out string) []string {
	args := []string{"-hide_banner", "-nostdin", "-y"}
	var vf string
	if o.Background == "image" {
		args = append(args, "-loop", "1", "-framerate", strconv.Itoa(visualsFPS), "-i", o.BackgroundPath)
		vf = fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1,format=yuv420p,ass=subs.ass", w, h, w, h)
	} else {
		colour := o.BackgroundColor
		if _, _, _, ok := media.ParseHexColor(colour); !ok {
			colour = "#11131a"
		}
		args = append(args, "-f", "lavfi", "-i", fmt.Sprintf("color=c=0x%s:s=%dx%d:r=%d", colour[1:], w, h, visualsFPS))
		vf = "format=yuv420p,ass=subs.ass"
	}
	args = append(args, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-vf", vf,
		"-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "192k", "-shortest",
		"-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out)
	return args
}

// runBurnAudio makes a video from an audio file: a background under the
// burned cues (SPEC.md §9.3).
func (m *Module) runBurnAudio(ctx context.Context, job *core.JobContext, o Options, ffmpeg string, info media.Info) error {
	input := job.Inputs[0]
	w, h := canvasSize(o)
	if err := writeASS(job.TempDir, o, w, h); err != nil {
		return err
	}
	tmp := filepath.Join(job.TempDir, "burn.mp4")
	if o.Background == "visualizer" {
		if m.an == nil || m.br == nil {
			return core.Errorf(core.CodeInternal, "Visuals aren't available")
		}
		out, err := renderVisualsFn(ctx, job, m.an, m.br, input, *o.Visuals, cueLines(o.Cues, o.Visuals.UseWords),
			w, h, visualsFPS, viz.ModeOpaque, viz.Range{}, 0, renderShare)
		if err != nil {
			return err
		}
		if err := muxFn(ctx, ffmpeg, out, input, 0, 0, visualsFPS, "subs.ass", tmp, func(p float64) {
			job.Progress(renderShare+(1-renderShare)*p, "Finishing the video")
		}); err != nil {
			return err
		}
	} else if err := runFFmpegFn(ctx, job, ffmpeg, job.TempDir, backgroundArgs(o, w, h, input, tmp),
		float64(info.DurationMs)/1000, "Making the video"); err != nil {
		return err
	}
	final := core.UniquePath(job.OutputDir, core.StemName(input)+" (subtitled)", ".mp4")
	return finishMedia(job, o.Action, tmp, final, "", len(o.Cues))
}

// runBurnOverlay burns cues into a video with visuals composited over it;
// the subtitles are drawn after the overlay so they stay on top.
func (m *Module) runBurnOverlay(ctx context.Context, job *core.JobContext, o Options, ffmpeg string, info media.Info) error {
	input := job.Inputs[0]
	if m.an == nil || m.br == nil {
		return core.Errorf(core.CodeInternal, "Visuals aren't available")
	}
	vw, vh := info.Video.Width, info.Video.Height
	fps := snapFPS(info.Video.FPS)
	if err := writeASS(job.TempDir, o, vw, vh); err != nil {
		return err
	}
	rw, rh := overlaySize(vw, vh)
	out, err := renderVisualsFn(ctx, job, m.an, m.br, input, *o.Visuals, cueLines(o.Cues, o.Visuals.UseWords),
		rw, rh, fps, viz.ModeOverlay, viz.Range{}, 0, renderShare)
	if err != nil {
		return err
	}
	tmp := filepath.Join(job.TempDir, "burn.mp4")
	if err := compositeFn(ctx, ffmpeg, out, input, false, "", fps, vw, vh, "subs.ass", tmp, func(p float64) {
		job.Progress(renderShare+(1-renderShare)*p, "Compositing")
	}); err != nil {
		return err
	}
	final := core.UniquePath(job.OutputDir, core.StemName(input)+" (subtitled)", ".mp4")
	return finishMedia(job, o.Action, tmp, final, "", len(o.Cues))
}
