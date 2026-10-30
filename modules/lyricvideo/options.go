package lyricvideo

import (
	"toolbox/core/lyrics"
	"toolbox/core/viz"
)

// Action is what one Lyric Video job does (SPEC.md §7.1).
type Action string

const (
	ActionLyrics  Action = "lyrics"  // make timed lyrics
	ActionRender  Action = "render"  // the whole video + .lrc
	ActionPreview Action = "preview" // a 10 s render into the cache
	ActionLRC     Action = "lrc"     // only write <base>.lrc from Lines
)

// Source is where timed lyrics come from.
type Source string

const (
	SourceDetect Source = "detect" // transcribe the isolated vocals
	SourceAlign  Source = "align"  // align pasted text to the vocals
	SourceFile   Source = "file"   // .lrc/.srt/.vtt (.txt = align)
)

// LyricWord and LyricLine are the shared timed-lyrics types (core/lyrics).
type (
	LyricWord = lyrics.Word
	LyricLine = lyrics.Line
)

// Look is how the video looks.
type Look struct {
	Background     string `json:"background"`     // "blur-cover" | "cover" | "color" | "gradient" | "image" | "video" | "visualizer"
	BackgroundPath string `json:"backgroundPath"` // image or video file for those backgrounds
	Color1         string `json:"color1"`         // #rrggbb
	Color2         string `json:"color2"`
	Font           string `json:"font"` // media.Fonts()
	TextColor      string `json:"textColor"`
	HighlightColor string `json:"highlightColor"`
	Karaoke        bool   `json:"karaoke"`    // word-by-word fill
	Position       string `json:"position"`   // "center" | "lower"
	ShowNext       bool   `json:"showNext"`   // the next line dimmed under the current one
	Visualizer     string `json:"visualizer"` // "none" | "wave" | "bars"
	TitleCard      bool   `json:"titleCard"`
	Title          string `json:"title"`
	Artist         string `json:"artist"`
	// Visuals is the Visualizer design used when Background is "visualizer"
	// (SPEC.md §9.2).
	Visuals viz.VisualsSpec `json:"visuals"`
}

// Options are Lyric Video's per-submission options. The input is the song.
type Options struct {
	Action         Action      `json:"action"`
	Source         Source      `json:"source"`     // lyrics
	Language       string      `json:"language"`   // lyrics: "" auto or a Transcribe code
	Text           string      `json:"text"`       // align: pasted lyrics, ≤ 20,000 chars
	LyricsPath     string      `json:"lyricsPath"` // file
	Lines          []LyricLine `json:"lines"`      // render/preview/lrc: 1–2,000
	Look           Look        `json:"look"`
	Audio          string      `json:"audio"`  // "original" | "instrumental"
	Aspect         string      `json:"aspect"` // "16:9" | "9:16" | "1:1"
	Height         int         `json:"height"` // 720 | 1080 (the short side)
	PreviewStartMs int64       `json:"previewStartMs"`
}

// DefaultLook: blurred cover, Arial, white text with a warm highlight,
// karaoke fill, centred, next line shown, no visualiser, title card.
func DefaultLook() Look {
	return Look{
		Background: "blur-cover", Color1: "#1b1f2a", Color2: "#3a2f5b", Font: "Arial",
		TextColor: "#ffffff", HighlightColor: "#ffd166", Karaoke: true, Position: "center",
		ShowNext: true, Visualizer: "none", TitleCard: true,
	}
}

// DefaultOptions: paste-and-align lyrics, original audio, 16:9 1080p.
func DefaultOptions() Options {
	return Options{
		Action: ActionLyrics, Source: SourceAlign, Lines: []LyricLine{}, Look: DefaultLook(),
		Audio: "original", Aspect: "16:9", Height: 1080,
	}
}

// Result is a job's result.
type Result struct {
	Action          Action      `json:"action"`
	Lines           []LyricLine `json:"lines"`           // lyrics
	Matched         float64     `json:"matched"`         // align: matched tokens / all (0..1)
	HasInstrumental bool        `json:"hasInstrumental"` // the cached instrumental exists
	PreviewPath     string      `json:"previewPath"`     // preview
	Outputs         []string    `json:"outputs"`         // render/lrc
}
