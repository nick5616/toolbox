package composer

// The composition document (SPEC.md Part B §B5.1). FROZEN (Wave B0).

type Composition struct {
	Version    int        `json:"version"` // 1
	Width      int        `json:"width"`   // canvas px at 1×: 1080 wide; height by aspect (1350 for 4:5)
	Height     int        `json:"height"`
	Aspect     string     `json:"aspect"` // "4:5" | "1:1" | "3:4" | "1.91:1" | "9:16" | "16:9"
	Background Background `json:"background"`
	Layers     []Layer    `json:"layers"` // bottom → top, ≤ 60
	Format     string     `json:"format"` // export: "jpg" | "png"
}

type Background struct {
	Kind   string    `json:"kind"`   // "color" | "gradient" | "image"
	Color  string    `json:"color"`  // #rrggbb
	Color2 string    `json:"color2"` // gradient end
	Angle  int       `json:"angle"`  // gradient, degrees
	Image  *ImageRef `json:"image"`  // kind image: cover-fitted, then pan/zoom
	PanX   float64   `json:"panX"`   // -1..1 (focal offset)
	PanY   float64   `json:"panY"`
	Zoom   float64   `json:"zoom"` // 1..4
	Blur   float64   `json:"blur"` // 0..1 (fraction of a 40 px radius at 1080)
	Look   Look      `json:"look"`
}

type ImageRef struct {
	Path     string `json:"path"`     // source file (never modified)
	Original string `json:"original"` // before "Remove background" ("" = Path is the original)
}

type Layer struct {
	ID       string      `json:"id"`
	Kind     string      `json:"kind"` // "image" | "text"
	Name     string      `json:"name"`
	Hidden   bool        `json:"hidden"`
	Locked   bool        `json:"locked"`
	X        float64     `json:"x"`        // centre, fraction of canvas width
	Y        float64     `json:"y"`        // centre, fraction of canvas height
	Size     float64     `json:"size"`     // image: width / canvas width; text: font size / canvas width
	Rotation float64     `json:"rotation"` // degrees, clockwise
	FlipX    bool        `json:"flipX"`
	Opacity  float64     `json:"opacity"` // 0..1
	Image    *ImageLayer `json:"image"`
	Text     *TextLayer  `json:"text"`
	Shadow   Shadow      `json:"shadow"`
	Outline  Outline     `json:"outline"`
	Look     Look        `json:"look"` // image layers
}

type ImageLayer struct {
	Ref    ImageRef `json:"ref"`
	Crop   Rect     `json:"crop"`   // fractions of the source, {0,0,1,1} = whole
	Radius float64  `json:"radius"` // corner radius, fraction of the layer's shorter side (0..0.5)
}

type TextLayer struct {
	Text       string  `json:"text"` // ≤ 500 chars, newlines allowed
	Font       string  `json:"font"` // media.Fonts()
	Bold       bool    `json:"bold"`
	Italic     bool    `json:"italic"`
	Color      string  `json:"color"`
	Align      string  `json:"align"`      // "left" | "center" | "right"
	LineHeight float64 `json:"lineHeight"` // 0.8..2
	Pill       string  `json:"pill"`       // background colour behind the text ("" = none)
}

type Shadow struct { // blur and offsets: fractions of canvas width
	On      bool    `json:"on"`
	Blur    float64 `json:"blur"`
	OffsetX float64 `json:"offsetX"`
	OffsetY float64 `json:"offsetY"`
	Opacity float64 `json:"opacity"`
	Color   string  `json:"color"`
}

type Outline struct { // follows the alpha edge (sticker border)
	On    bool    `json:"on"`
	Width float64 `json:"width"` // fraction of canvas width
	Color string  `json:"color"`
}

type Look struct {
	Preset     string  `json:"preset"`     // none | vivid | warm | cool | mono | fade | noir
	Brightness float64 `json:"brightness"` // -1..1
	Contrast   float64 `json:"contrast"`
	Saturation float64 `json:"saturation"`
	Warmth     float64 `json:"warmth"`
}

type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}
