package subtitles

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/media"
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
		"-map", "0:v:0", "-map", "0:a:0?",
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
	info, err := media.Probe(ctx, ffprobe, input)
	if err != nil {
		return err
	}
	if info.Video == nil {
		return core.ValidationError("Burning in needs a video file", nil)
	}
	f, err := os.Create(filepath.Join(job.TempDir, "subs.ass"))
	if err != nil {
		return fmt.Errorf("create subs.ass: %w", err)
	}
	_, werr := buildASS(o.Cues, o, info.Video.Width, info.Video.Height).WriteTo(f)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return fmt.Errorf("write subs.ass: %w", werr)
	}
	audio := ""
	if len(info.Audio) > 0 {
		audio = info.Audio[0].Codec
	}
	tmp := filepath.Join(job.TempDir, "burn.mp4")
	if err := runFFmpeg(ctx, job, ffmpeg, job.TempDir, burnArgs(input, tmp, audio), float64(info.DurationMs)/1000, "Burning in subtitles"); err != nil {
		return err
	}
	final := core.UniquePath(job.OutputDir, core.StemName(input)+" (subtitled)", ".mp4")
	return finishMedia(job, o.Action, tmp, final, "", len(o.Cues))
}
