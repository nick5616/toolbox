package editstudio

// Edit Studio's project document (SPEC.md §6.1; v2: Phase 21 SPEC §B0, §E3.6). FROZEN after Wave 0: the
// generated TS bindings mirror it, and the frontend's JSON-in-string fields
// (Speed, Transform, Masks, Effects, In, Look, Captions.Style/Lines,
// RecipeRun.Options) are validated by frontend/src/viz/edit/schema.ts.

type EditProject struct {
	Version         int             `json:"version"`     // 2 (v1 documents load unchanged: every v2 field's zero value means v1 behaviour)
	Aspect          string          `json:"aspect"`      // "9:16" | "4:5" | "1:1" | "16:9"
	FPS             int             `json:"fps"`         // 24 | 25 | 30 | 60
	Song            *Song           `json:"song"`        // nil until picked
	AnalysisKey     string          `json:"analysisKey"` // viz.AnalysisRef.Key; "" until analysed
	Markers         MarkerState     `json:"markers"`
	Sources         []Source        `json:"sources"`          // the Sources panel, ≤ 300
	Tracks          []Track         `json:"tracks"`           // 1..12 (≤ 8 video/adjust); index 0 = bottom
	Captions        *Captions       `json:"captions"`         // nil = off
	Look            string          `json:"look"`             // EditPost[] JSON: global chain incl. bloom/vignette/grain; "" = none
	Background      string          `json:"background"`       // "#rrggbb" under every track
	CutOffsetFrames int             `json:"cutOffsetFrames"`  // −3..3
	Seed            int64           `json:"seed"`             // engine seed (rng keys, grain, glitch)
	Recipe          *RecipeRun      `json:"recipe"`           // last auto-fill
	ExportHeight    int             `json:"exportHeight"`     // short side: 720 | 1080 | 1440 | 2160
	Export          *ExportSettings `json:"export,omitempty"` // nil = H.264, good, project fps, 192 kb/s, whole edit
	// Size overrides Aspect/ExportHeight for in-memory renders (Color Grader,
	// still plans): even, 64..8192 for stills, ≤ 3840 on the long side for video.
	// Stored projects never set it.
	Size *Size `json:"size,omitempty"`
}

// ExportSettings are the Video Editor's export choices (Phase 21 SPEC §B6).
// The size stays in EditProject.ExportHeight.
type ExportSettings struct {
	FPS       int    `json:"fps"`       // 0 = project; else 24 | 25 | 30 | 60
	Codec     string `json:"codec"`     // "h264" | "h265"
	Quality   string `json:"quality"`   // "draft" | "good" | "best" → CRF 26 / 20 / 16 (h265: +4)
	AudioKbps int    `json:"audioKbps"` // 128 | 192 | 320
	InMs      int64  `json:"inMs"`      // range (timeline ms); InMs == OutMs == 0 = whole edit
	OutMs     int64  `json:"outMs"`
}

// Size is an explicit output size in pixels.
type Size struct {
	W int `json:"w"`
	H int `json:"h"`
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
	Kind   string `json:"kind"`             // "video" | "adjust" | "audio"
	Name   string `json:"name"`             // ≤ 40 chars
	Muted  bool   `json:"muted"`            // not drawn (video) / not applied (adjust); its clips' audio is not mixed
	Locked bool   `json:"locked"`           // no edits; auto-fill skips it
	Solo   bool   `json:"solo,omitempty"`   // audio: when any track is solo, only solo tracks are heard
	Height string `json:"height,omitempty"` // "s" | "m" | "l"; "" = "m"
	// Matte (video tracks, Part B): "" | "alpha" | "alpha-inverted" | "luma" | "luma-inverted".
	// The track shows only where the video track directly above it is opaque (alpha) or
	// bright (luma); that track becomes the matte and isn't drawn itself.
	Matte string `json:"matte"`
	Clips []Clip `json:"clips"` // sorted by StartMs, non-overlapping; ≤ 500 clips per project
}

type Clip struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`               // "video" | "image" | "color" | "text" | "visual" (video tracks) | "adjust" (adjust tracks) | "audio" (audio tracks; Path = any audio or video file)
	Path      string    `json:"path"`               // video/image
	Color     string    `json:"color"`              // color: "#rrggbb"
	StartMs   int64     `json:"startMs"`            // timeline ms
	EndMs     int64     `json:"endMs"`              // timeline ms, > StartMs
	InMs      int64     `json:"inMs"`               // video: source ms at StartMs
	Speed     string    `json:"speed"`              // EditParam JSON, keys only (no mods), 0..4; "" = 1
	Slow      string    `json:"slow"`               // "blend" (default) | "none" | "interpolate"
	Volume    float64   `json:"volume"`             // 0..2 base gain; video and audio clips
	Gain      string    `json:"gain,omitempty"`     // EditParam JSON, keys only, dB −60..12; "" = 0 dB. Effective = Volume × dB(Gain(t))
	FadeInMs  int64     `json:"fadeInMs,omitempty"` // audio fade, 0..10,000 (0 = the 10 ms de-click)
	FadeOutMs int64     `json:"fadeOutMs,omitempty"`
	Link      string    `json:"link,omitempty"` // clips sharing a Link move/trim/split/delete together; "" = none
	Fit       string    `json:"fit"`            // "fill" | "fit" | "fit-blur" | "fit-color" (video/image)
	FitColor  string    `json:"fitColor"`       // "#rrggbb"
	FlipX     bool      `json:"flipX"`
	Blend     string    `json:"blend"`           // "normal" | "add" | "screen" | "multiply" | "overlay" | "softlight" | "hardlight" | "difference" | "exclusion" | "lighten" | "darken" | "colordodge"
	Transform string    `json:"transform"`       // ClipTransform JSON; "" = identity
	Matte     *Matte    `json:"matte"`           // nil = none
	Depth     *DepthRef `json:"depth,omitempty"` // nil = none (Phase 21 Part E: a depth map for depth-aware effects)
	FxTarget  string    `json:"fxTarget"`        // "clip" | "subject" | "background" (subject/background need a ready matte)
	Masks     string    `json:"masks"`           // Mask[] JSON; "" = none
	Effects   string    `json:"effects"`         // EditPost[] JSON; "" = none
	In        string    `json:"in"`              // EditTransition JSON into this clip; "" = cut
	Text      string    `json:"text"`            // text clips: TextClip JSON (Part B); "" otherwise
	Visual    string    `json:"visual"`          // visual clips: VisualClip JSON (a Visualizer layer, Part B); "" otherwise
	Pinned    bool      `json:"pinned"`          // auto-fill never touches it
	Auto      bool      `json:"auto"`            // made by auto-fill and not edited since
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

// DepthRef names a clip's depth map. Stored projects: <project>/depth/<ID>-{preview,export}.h264
// (+ .idx.json), or <ID>.png for images; in-memory renders pass the files in
// the plan (EditFiles key "d:<ID>").
type DepthRef struct {
	ID     string `json:"id"`
	FromMs int64  `json:"fromMs"` // source range covered (video)
	ToMs   int64  `json:"toMs"`
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
