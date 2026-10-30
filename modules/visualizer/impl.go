package visualizer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
)

var (
	aspects    = []string{"16:9", "9:16", "1:1", "4:5"}
	heights    = []int{720, 1080, 1440, 2160}
	fpsChoices = []int{30, 60}
)

func bad(field, msg string) error {
	return core.ValidationError(msg, map[string]string{field: msg})
}

func isVideoPath(p string) bool {
	return slices.Contains(media.VideoExtensions(), strings.ToLower(filepath.Ext(p)))
}

func regularFile(p string) bool {
	fi, err := os.Stat(p)
	return p != "" && err == nil && fi.Mode().IsRegular()
}

// validateAnalyze checks the analyze options (SPEC.md §4.3, §5.1).
func validateAnalyze(a viz.AnalyzeOptions) error {
	switch a.Words {
	case "", viz.WordsNone, viz.WordsDetect:
	case viz.WordsAlign:
		if strings.TrimSpace(a.LyricsText) == "" {
			return bad("analyze.lyricsText", "Paste the lyrics first")
		}
		if len([]rune(a.LyricsText)) > viz.MaxLyricsChars {
			return bad("analyze.lyricsText", fmt.Sprintf("Keep the lyrics under %d characters", viz.MaxLyricsChars))
		}
	case viz.WordsFile:
		if !regularFile(a.LyricsPath) {
			return bad("analyze.lyricsPath", "Choose a lyrics file")
		}
		if !slices.Contains([]string{".lrc", ".srt", ".vtt", ".txt"}, strings.ToLower(filepath.Ext(a.LyricsPath))) {
			return bad("analyze.lyricsPath", "Use a .lrc, .srt, .vtt or .txt file")
		}
	case viz.WordsGiven:
		if len(a.Lines) == 0 || len(a.Lines) > viz.MaxGivenLines {
			return bad("analyze.lines", "Add between 1 and 20,000 lines")
		}
		for i, l := range a.Lines {
			if l.StartMs < 0 || l.EndMs < l.StartMs || (i > 0 && l.StartMs < a.Lines[i-1].StartMs) {
				return bad(fmt.Sprintf("analyze.lines.%d", i), "The lines must be in time order with valid times")
			}
		}
	default:
		return bad("analyze.words", "Choose where the words come from")
	}
	if len(a.Language) > 12 {
		return bad("analyze.language", "Unknown language")
	}
	if a.SaveStems && !a.Stems {
		return bad("analyze.saveStems", "Turn on Separate instruments to save the stems")
	}
	return nil
}

// validateRender checks the render/preview options (SPEC.md §7.1).
func (m *Module) validateRender(input string, o Options) error {
	if o.AnalysisKey == "" {
		return bad("analysisKey", "Analyze the file first")
	}
	ref, ok := m.an.Lookup(o.AnalysisKey)
	if !ok {
		return bad("analysisKey", "Analyze the file again")
	}
	if strings.TrimSpace(o.ShowJSON) == "" || len(o.ShowJSON) > viz.MaxShowBytes || !json.Valid([]byte(o.ShowJSON)) {
		return bad("showJson", "This design couldn't be read")
	}
	switch o.Mode {
	case ModeFull:
		if !slices.Contains(aspects, o.Aspect) {
			return bad("aspect", "Choose 16:9, 9:16, 1:1 or 4:5")
		}
		if !slices.Contains(heights, o.Height) {
			return bad("height", "Choose 720p, 1080p, 1440p or 2160p")
		}
		if !slices.Contains(fpsChoices, o.FPS) {
			return bad("fps", "Choose 30 or 60 fps")
		}
		switch o.Background {
		case "", "none", "cover":
		case "image":
			if !regularFile(o.BackgroundPath) || !slices.Contains(media.ImageExtensions(), strings.ToLower(filepath.Ext(o.BackgroundPath))) {
				return bad("backgroundPath", "Choose a background image")
			}
		case "video":
			if !regularFile(o.BackgroundPath) || !isVideoPath(o.BackgroundPath) {
				return bad("backgroundPath", "Choose a background video")
			}
		default:
			return bad("background", "Choose a background")
		}
	case ModeOverlay:
		if !isVideoPath(input) {
			return bad("mode", "Visuals over the video need a video file")
		}
	default:
		return bad("mode", "Choose full visuals or over the video")
	}
	if o.StartMs < 0 || (o.EndMs != 0 && o.EndMs <= o.StartMs) {
		return bad("endMs", "The range is empty")
	}
	switch o.Audio {
	case "", "original":
	case "instrumental":
		if ref.Instrumental == "" {
			return bad("audio", "Separate the instruments to use the instrumental")
		}
	default:
		return bad("audio", "Choose the original or the instrumental")
	}
	return nil
}

func (m *Module) validateOptions(inputs []string, o Options) error {
	switch o.Action {
	case ActionAnalyze:
		return validateAnalyze(o.Analyze)
	case ActionRender, ActionPreview:
		return m.validateRender(inputs[0], o)
	default:
		return bad("action", "Unknown action")
	}
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	if len(inputs) != 1 {
		return bad("inputs", "Add one song or video")
	}
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return m.validateOptions(inputs, o)
}
