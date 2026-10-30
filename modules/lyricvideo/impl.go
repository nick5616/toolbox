package lyricvideo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

const maxLyricsChars = 20_000

func isHex(c string) bool {
	_, _, _, ok := media.ParseHexColor(c)
	return ok
}

// validateOptions checks Options for its action (SPEC.md §7.1). Empty look
// fields are allowed: they take defaults at render time.
func validateOptions(o Options) error {
	fields := map[string]string{}
	oneOf := func(key, v string, allowed ...string) {
		if v != "" && !slices.Contains(allowed, v) {
			fields[key] = "Choose a listed value"
		}
	}
	switch o.Action {
	case ActionLyrics, ActionRender, ActionPreview, ActionLRC:
	default:
		fields["action"] = "Choose lyrics, render, preview or lrc"
	}
	l := o.Look
	oneOf("look.background", l.Background, "blur-cover", "cover", "color", "gradient", "image", "video", "visualizer")
	if l.Background == "visualizer" && (o.Action == ActionRender || o.Action == ActionPreview) {
		if s := strings.TrimSpace(l.Visuals.ShowJSON); s == "" || len(s) > viz.MaxShowBytes || !json.Valid([]byte(s)) {
			fields["look.visuals"] = "Choose a visual design"
		}
	}
	oneOf("look.position", l.Position, "center", "lower")
	oneOf("look.visualizer", l.Visualizer, "none", "wave", "bars")
	oneOf("audio", o.Audio, "original", "instrumental")
	oneOf("aspect", o.Aspect, "16:9", "9:16", "1:1")
	if o.Height != 0 && o.Height != 720 && o.Height != 1080 {
		fields["height"] = "Choose 720 or 1080"
	}
	for k, c := range map[string]string{"look.color1": l.Color1, "look.color2": l.Color2, "look.textColor": l.TextColor, "look.highlightColor": l.HighlightColor} {
		if c != "" && !isHex(c) {
			fields[k] = "Use a colour like #rrggbb"
		}
	}
	if l.Font != "" && !slices.Contains(media.Fonts(), l.Font) {
		fields["look.font"] = "Choose a listed font"
	}
	if o.PreviewStartMs < 0 {
		fields["previewStartMs"] = "Start can't be negative"
	}
	if len(fields) > 0 {
		return core.ValidationError("Some options are invalid", fields)
	}

	switch o.Action {
	case ActionLyrics:
		switch o.Source {
		case SourceDetect:
		case SourceAlign:
			t := strings.TrimSpace(o.Text)
			if t == "" {
				return core.ValidationError("Paste the lyrics first", map[string]string{"text": "Paste the lyrics first"})
			}
			if len([]rune(o.Text)) > maxLyricsChars {
				return core.ValidationError("The lyrics are too long", map[string]string{"text": fmt.Sprintf("Keep it under %d characters", maxLyricsChars)})
			}
		case SourceFile:
			if fi, err := os.Stat(o.LyricsPath); o.LyricsPath == "" || err != nil || !fi.Mode().IsRegular() {
				return core.ValidationError("Choose a lyrics file", map[string]string{"lyricsPath": "File not found"})
			}
			if !slices.Contains([]string{".lrc", ".srt", ".vtt", ".txt"}, strings.ToLower(filepath.Ext(o.LyricsPath))) {
				return core.ValidationError("Use a .lrc, .srt, .vtt or .txt file", map[string]string{"lyricsPath": "Unsupported file type"})
			}
		default:
			return core.ValidationError("Choose where the lyrics come from", map[string]string{"source": "Choose detect, align or file"})
		}
	case ActionRender, ActionPreview:
		if err := validateLines(o.Lines); err != nil {
			return err
		}
		if l.Background == "image" || l.Background == "video" {
			if fi, err := os.Stat(l.BackgroundPath); l.BackgroundPath == "" || err != nil || !fi.Mode().IsRegular() {
				return core.ValidationError("Choose a background file", map[string]string{"look.backgroundPath": "File not found"})
			}
		}
	case ActionLRC:
		return validateLines(o.Lines)
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

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := validateOptions(o); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add a song", map[string]string{"inputs": "Add a song"})
	}
	switch o.Action {
	case ActionLRC:
		return m.runLRC(job, o)
	case ActionLyrics:
		if o.Source != SourceFile || strings.EqualFold(filepath.Ext(o.LyricsPath), ".txt") {
			if _, err := job.Tool(sidecar.DepID); err != nil {
				return err
			}
		}
		return m.runLyrics(ctx, job, o)
	default:
		if o.Audio == "instrumental" {
			if _, inst := m.cachedStems(job.Inputs[0]); inst == "" {
				if _, err := job.Tool(sidecar.DepID); err != nil {
					return err
				}
			}
		}
		return m.runRender(ctx, job, o)
	}
}
