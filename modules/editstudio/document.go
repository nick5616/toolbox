package editstudio

// Edit Studio's project document (SPEC.md §6.1). FROZEN after Wave 0: the
// generated TS bindings mirror it, and the frontend's JSON-in-string fields
// (Speed, Transform, Masks, Effects, In, Look, Captions.Style/Lines,
// RecipeRun.Options) are validated by frontend/src/viz/edit/schema.ts.

type EditProject struct {
	Version         int         `json:"version"`     // 1
	Aspect          string      `json:"aspect"`      // "9:16" | "4:5" | "1:1" | "16:9"
	FPS             int         `json:"fps"`         // 30 | 60
	Song            *Song       `json:"song"`        // nil until picked
	AnalysisKey     string      `json:"analysisKey"` // viz.AnalysisRef.Key; "" until analysed
	Markers         MarkerState `json:"markers"`
	Sources         []Source    `json:"sources"`         // the Sources panel, ≤ 300
	Tracks          []Track     `json:"tracks"`          // 1..8; index 0 = bottom
	Captions        *Captions   `json:"captions"`        // nil = off
	Look            string      `json:"look"`            // EditPost[] JSON: global chain incl. bloom/vignette/grain; "" = none
	Background      string      `json:"background"`      // "#rrggbb" under every track
	CutOffsetFrames int         `json:"cutOffsetFrames"` // −3..3
	Seed            int64       `json:"seed"`            // engine seed (rng keys, grain, glitch)
	Recipe          *RecipeRun  `json:"recipe"`          // last auto-fill
	ExportHeight    int         `json:"exportHeight"`    // short side: 720 | 1080 | 1440
}

type Song struct {
	Path      string  `json:"path"`
	StartMs   int64   `json:"startMs"`   // song ms
	EndMs     int64   `json:"endMs"`     // song ms; EndMs − StartMs = D (§4)
	GainDb    float64 `json:"gainDb"`    // −24..12
	FadeInMs  int64   `json:"fadeInMs"`  // 0..10,000
	FadeOutMs int64   `json:"fadeOutMs"` // 0..10,000
}

type MarkerState struct {
	Lanes     map[string]LaneSettings `json:"lanes"`     // missing lane = defaults (§5.2)
	BarOffset int                     `json:"barOffset"` // 0..3
	Hidden    []string                `json:"hidden"`    // derived marker ids, ≤ 5,000
	Moved     map[string]int64        `json:"moved"`     // id → song ms, ≤ 5,000
	Labels    map[string]string       `json:"labels"`    // section id → label (≤ 24 chars)
	Custom    []CustomMarker          `json:"custom"`    // ≤ 2,000
}

type LaneSettings struct {
	Visible     bool    `json:"visible"`
	MinStrength float64 `json:"minStrength"` // 0..1
	Every       int     `json:"every"`       // 1..16
	FirstOfBar  bool    `json:"firstOfBar"`
	NudgeMs     int64   `json:"nudgeMs"` // −200..200
}

type CustomMarker struct {
	ID    string `json:"id"`
	Ms    int64  `json:"ms"`    // song ms
	Label string `json:"label"` // ≤ 40 chars
}

type Source struct {
	Path string   `json:"path"`
	Tags []string `json:"tags"` // ≤ 8, each 1..24 chars, lower-case; "hero" | "closeup" | "wide" | "broll" are offered first
}

type Track struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`   // "video" | "adjust"
	Name   string `json:"name"`   // ≤ 40 chars
	Muted  bool   `json:"muted"`  // not drawn (video) / not applied (adjust); its clips' audio is not mixed
	Locked bool   `json:"locked"` // no edits; auto-fill skips it
	Clips  []Clip `json:"clips"`  // sorted by StartMs, non-overlapping; ≤ 500 clips per project
}

type Clip struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`     // "video" | "image" | "color" (video tracks) | "adjust" (adjust tracks)
	Path      string  `json:"path"`     // video/image
	Color     string  `json:"color"`    // color: "#rrggbb"
	StartMs   int64   `json:"startMs"`  // timeline ms
	EndMs     int64   `json:"endMs"`    // timeline ms, > StartMs
	InMs      int64   `json:"inMs"`     // video: source ms at StartMs
	Speed     string  `json:"speed"`    // EditParam JSON, keys only (no mods), 0..4; "" = 1
	Slow      string  `json:"slow"`     // "blend" (default) | "none" | "interpolate"
	Volume    float64 `json:"volume"`   // 0..2; video only; heard in exports only
	Fit       string  `json:"fit"`      // "fill" | "fit" | "fit-blur" | "fit-color" (video/image)
	FitColor  string  `json:"fitColor"` // "#rrggbb"
	FlipX     bool    `json:"flipX"`
	Blend     string  `json:"blend"`     // "normal" | "add" | "screen" | "multiply"
	Transform string  `json:"transform"` // ClipTransform JSON; "" = identity
	Matte     *Matte  `json:"matte"`     // nil = none
	FxTarget  string  `json:"fxTarget"`  // "clip" | "subject" | "background" (subject/background need a ready matte)
	Masks     string  `json:"masks"`     // Mask[] JSON; "" = none
	Effects   string  `json:"effects"`   // EditPost[] JSON; "" = none
	In        string  `json:"in"`        // EditTransition JSON into this clip; "" = cut
	Pinned    bool    `json:"pinned"`    // auto-fill never touches it
	Auto      bool    `json:"auto"`      // made by auto-fill and not edited since
}

type Matte struct {
	Mode    string       `json:"mode"`   // "people" | "select" | "image"
	ID      string       `json:"id"`     // set by the UI when it submits the matte job; files <project>/mattes/<ID>-{preview,export}.h264 + .idx.json (image: <ID>.png)
	FromMs  int64        `json:"fromMs"` // source range the matte covers (video)
	ToMs    int64        `json:"toMs"`
	Clicks  []MatteClick `json:"clicks"` // select: ≤ 64
	Cutout  bool         `json:"cutout"` // the clip shows only the subject
	Invert  bool         `json:"invert"`
	Feather float64      `json:"feather"` // 0..1 (→ 0..1 % of the short side)
	Stroke  MatteStroke  `json:"stroke"`
	Glow    MatteGlow    `json:"glow"`
}

type MatteClick struct {
	Ms       int64   `json:"ms"` // source ms (snapped to a frame)
	X        float64 `json:"x"`  // 0..1 of the upright source frame
	Y        float64 `json:"y"`
	Positive bool    `json:"positive"` // false = "not this"
}

type MatteStroke struct {
	Px    float64 `json:"px"`    // 0..40 at a 1080 short side (scaled to the output)
	Color string  `json:"color"` // "#rrggbb"
}

type MatteGlow struct {
	Amount float64 `json:"amount"` // 0..1
	Color  string  `json:"color"`
}

type Captions struct {
	Style         string `json:"style"` // viz TextStyle JSON
	BehindSubject bool   `json:"behindSubject"`
	Lines         string `json:"lines"` // TextLine[] JSON (song ms) replacing the analysis's words; "" = the analysis
}

type RecipeRun struct {
	RecipeID string `json:"recipeId"`
	Seed     int64  `json:"seed"`
	Run      int    `json:"run"`     // increments per apply; part of generated clip IDs
	Options  string `json:"options"` // AutofillOptions JSON (§13.2)
}
