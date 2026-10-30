package subtitles

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core/media"
	"toolbox/core/viz"
)

// burnsAudio reports whether a burn has what it needs to make a video from
// an audio file: a background (SPEC.md §9.3).
func burnsAudio(o Options) bool {
	switch o.Background {
	case "visualizer":
		return o.Visuals != nil
	case "color", "image":
		return true
	}
	return false
}

// validateBurnCanvas checks the "make a video" fields of a burn. They are
// only used for audio inputs, but must be sensible whenever they are set.
func validateBurnCanvas(o Options) map[string]string {
	f := map[string]string{}
	if o.Canvas != "" && !slices.Contains([]string{"16:9", "9:16", "1:1"}, o.Canvas) {
		f["canvas"] = "Choose 16:9, 9:16 or 1:1"
	}
	if o.CanvasHeight != 0 && o.CanvasHeight != 720 && o.CanvasHeight != 1080 {
		f["canvasHeight"] = "Choose 720p or 1080p"
	}
	switch o.Background {
	case "", "visualizer", "color":
	case "image":
		fi, err := os.Stat(o.BackgroundPath)
		ext := strings.ToLower(filepath.Ext(o.BackgroundPath))
		if o.BackgroundPath == "" || err != nil || !fi.Mode().IsRegular() ||
			!slices.Contains(media.ImageExtensions(), ext) || ext == ".heic" || ext == ".heif" { // FFmpeg can't read HEIC
			f["backgroundPath"] = "Choose a background image"
		}
	default:
		f["background"] = "Choose a background"
	}
	if o.BackgroundColor != "" {
		if _, _, _, ok := media.ParseHexColor(o.BackgroundColor); !ok {
			f["backgroundColor"] = "Use a colour like #rrggbb"
		}
	}
	if o.Visuals != nil {
		if s := strings.TrimSpace(o.Visuals.ShowJSON); s == "" || len(s) > viz.MaxShowBytes || !json.Valid([]byte(s)) {
			f["visuals"] = "Choose a visual design"
		}
	}
	return f
}
