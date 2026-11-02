package videoeditor

// The video project document (SPEC.md Part B §B6.1, §B6.3). FROZEN (Wave B0).

type VideoProject struct {
	Version   int     `json:"version"` // 1
	Aspect    string  `json:"aspect"`  // "9:16" | "4:5" | "1:1" | "16:9"
	Clips     []Clip  `json:"clips"`   // 1–200
	Music     *Music  `json:"music"`
	Titles    []Title `json:"titles"`    // ≤ 100
	MaxSizeMB int     `json:"maxSizeMB"` // 0 = none
}

type Clip struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"` // "video" | "image"
	Path       string     `json:"path"`
	InMs       int64      `json:"inMs"`       // video
	OutMs      int64      `json:"outMs"`      // video; > InMs, ≥ 300 ms after speed
	DurationMs int64      `json:"durationMs"` // image: 1,000–10,000
	Speed      float64    `json:"speed"`      // 0.5 | 0.75 | 1 | 1.5 | 2
	Volume     float64    `json:"volume"`     // 0..2 (0 = muted)
	Fit        string     `json:"fit"`        // "fill" | "fit-blur" | "fit-color"
	FitColor   string     `json:"fitColor"`
	PanX       float64    `json:"panX"` // fill: -1..1 focal offset
	PanY       float64    `json:"panY"`
	Zoom       float64    `json:"zoom"`       // 1..3
	Motion     string     `json:"motion"`     // image: "none" | "in" | "out" | "left" | "right"
	Look       string     `json:"look"`       // none|vivid|warm|cool|mono|fade|noir (FFmpeg eq/colorchannelmixer presets)
	Transition Transition `json:"transition"` // into the NEXT clip
}

type Transition struct {
	Kind       string `json:"kind"`       // "cut" | "fade" | "dip" | "slide"
	DurationMs int64  `json:"durationMs"` // 200–1,500; ≤ half of either neighbour
}

type Music struct {
	Path         string  `json:"path"`
	OffsetMs     int64   `json:"offsetMs"` // where in the song the video starts
	Volume       float64 `json:"volume"`   // 0..1.5
	FadeInMs     int64   `json:"fadeInMs"`
	FadeOutMs    int64   `json:"fadeOutMs"`
	Duck         bool    `json:"duck"`         // lower the music while clips have sound (sidechaincompress)
	EndWithMusic bool    `json:"endWithMusic"` // trim the video to the song's end (else fade the song at the video's end)
}

type Title struct {
	ID         string `json:"id"`
	Text       string `json:"text"` // ≤ 200 chars
	StartMs    int64  `json:"startMs"`
	DurationMs int64  `json:"durationMs"`
	Style      string `json:"style"`    // "title" | "lower-third" | "caption" | "label"
	Position   string `json:"position"` // "top" | "center" | "bottom"
	Font       string `json:"font"`
	Color      string `json:"color"`
}

type PlanRequest struct {
	Paths      []string `json:"paths"`     // clips and photos, 1–200
	MusicPath  string   `json:"musicPath"` // optional
	Aspect     string   `json:"aspect"`
	Order      string   `json:"order"`      // "as-given" | "date-taken"
	TargetMs   int64    `json:"targetMs"`   // 0 = fit to the music (or ~3 s per clip without music)
	BeatCut    bool     `json:"beatCut"`    // cut on the music's bars (needs MusicPath)
	Transition string   `json:"transition"` // default for every join
}
