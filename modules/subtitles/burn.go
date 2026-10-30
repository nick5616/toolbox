package subtitles

import (
	"context"
	"math"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
)

// Seams: tests replace these so burns run without FFmpeg, the engine or the
// webview renderer.
var (
	probeFn         = media.Probe
	renderVisualsFn = viz.RenderVisuals
	muxFn           = viz.MuxOpaque
	compositeFn     = viz.CompositeOverlay
	runFFmpegFn     = runFFmpeg
)

// buildASS builds the burn-in script for a video of display size w×h.
func buildASS(cues []Cue, o Options, w, h int) media.ASSDoc {
	shorter := float64(min(w, h))
	pct := map[string]float64{"s": 0.045, "m": 0.055, "l": 0.065}[o.Size]
	if pct == 0 {
		pct = 0.055
	}
	size := pct * shorter
	if h > w {
		size *= 1.25
	}
	size = math.Round(size*10) / 10
	align := 2
	if o.Position == "top" {
		align = 8
	}
	font := o.Font
	if font == "" {
		font = media.DefaultFont
	}
	marginV := int(math.Round(0.06 * float64(h)))
	marginH := int(math.Round(0.05 * float64(w)))
	name := string(o.Style)
	if name == "" {
		name = string(StyleClassic)
	}
	st := media.ASSStyle{
		Name: name, Font: font, Size: size,
		Primary: "#FFFFFF", Secondary: "#FFFFFF", Outline: "#000000", Back: "#000000",
		BackAlpha: 255, OutlineAlpha: 0,
		BorderStyle: 1, Alignment: align, MarginL: marginH, MarginR: marginH, MarginV: marginV,
	}
	round1 := func(v float64) float64 { return math.Round(v*10) / 10 }
	switch o.Style {
	case StyleBoxed:
		st.BorderStyle = 3
		st.Outline, st.OutlineAlpha = "#000000", 115 // box colour: black at 55%
		st.Back, st.BackAlpha = "#000000", 115
		st.OutlineWidth = round1(size * 0.18) // box padding
	case StyleYellow:
		st.Primary, st.Bold = "#FFE14D", true
		st.OutlineWidth = round1(size * 0.06)
	case StyleMinimal:
		st.Back, st.BackAlpha = "#000000", 100
		st.Shadow = round1(size * 0.05)
	default: // classic
		st.OutlineWidth = round1(size * 0.06)
	}
	doc := media.ASSDoc{PlayResX: w, PlayResY: h, Styles: []media.ASSStyle{st}}
	for _, c := range cues {
		doc.Events = append(doc.Events, media.ASSEvent{StartMs: c.StartMs, EndMs: c.EndMs, Style: name, Text: media.ASSEscape(c.Text)})
	}
	return doc
}

// burnArgs builds the ffmpeg arguments (run with Dir = the folder holding subs.ass).
func burnArgs(input, out string, audioCodec string) []string {
	args := []string{"-hide_banner", "-nostdin", "-y", "-i", input,
		"-vf", "ass=subs.ass",
		"-map", "0:v:0", "-map", "0:a?",
		"-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"}
	if audioCodec == "aac" || audioCodec == "mp3" {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	}
	return append(args, "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out)
}

func (m *Module) runBurn(ctx context.Context, job *core.JobContext, o Options) error {
	input := job.Inputs[0]
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	info, err := probeFn(ctx, ffprobe, input)
	if err != nil {
		return err
	}
	if info.Video == nil {
		if !burnsAudio(o) {
			return core.ValidationError("Choose a background for the video", map[string]string{"background": "Choose a background"})
		}
		return m.runBurnAudio(ctx, job, o, ffmpeg, info)
	}
	if o.Visuals != nil {
		return m.runBurnOverlay(ctx, job, o, ffmpeg, info)
	}
	if err := writeASS(job.TempDir, o, info.Video.Width, info.Video.Height); err != nil {
		return err
	}
	// Copy audio only when every track is already AAC or MP3.
	audio := ""
	for i, a := range info.Audio {
		if i == 0 {
			audio = a.Codec
		} else if a.Codec != audio {
			audio = "mixed"
		}
	}
	tmp := filepath.Join(job.TempDir, "burn.mp4")
	if err := runFFmpegFn(ctx, job, ffmpeg, job.TempDir, burnArgs(input, tmp, audio), float64(info.DurationMs)/1000, "Burning in subtitles"); err != nil {
		return err
	}
	final := core.UniquePath(job.OutputDir, core.StemName(input)+" (subtitled)", ".mp4")
	return finishMedia(job, o.Action, tmp, final, "", len(o.Cues))
}
