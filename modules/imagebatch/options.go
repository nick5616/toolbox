package imagebatch

// ResizeMode says how the size is set.
type ResizeMode string

const (
	ResizeKeep     ResizeMode = "keep"     // leave the size alone
	ResizeLongSide ResizeMode = "longSide" // the longer side becomes LongSide
	ResizeExact    ResizeMode = "exact"    // exactly Width × Height (Fit decides how)
)

// Fit says how a different shape is handled.
type Fit string

const (
	FitCrop Fit = "crop" // cut from the centre
	FitPad  Fit = "pad"  // fill the rest with Background
)

// Format is the output file type.
type Format string

const (
	FormatSame Format = "same" // the input's type (JPEG, PNG or WebP; anything else becomes JPEG)
	FormatJPG  Format = "jpg"
	FormatPNG  Format = "png"
	FormatWebP Format = "webp"
)

// Corner is where a watermark sits.
type Corner string

const (
	CornerTopLeft     Corner = "tl"
	CornerTopRight    Corner = "tr"
	CornerBottomLeft  Corner = "bl"
	CornerBottomRight Corner = "br"
	CornerCenter      Corner = "center"
)

// WatermarkKind is none, text or a logo image.
type WatermarkKind string

const (
	WatermarkNone WatermarkKind = "none"
	WatermarkText WatermarkKind = "text"
	WatermarkLogo WatermarkKind = "logo"
)

// Watermark is the optional mark drawn over every image.
type Watermark struct {
	Kind    WatermarkKind `json:"kind"`
	Text    string        `json:"text"`    // text: up to 200 characters
	Font    string        `json:"font"`    // text: one of media.Fonts()
	Color   string        `json:"color"`   // text: "#rrggbb"
	Logo    string        `json:"logo"`    // logo: path of an image
	Corner  Corner        `json:"corner"`  // where it sits
	Opacity float64       `json:"opacity"` // 0.05..1
	// Size is the text height (text) or the logo width (logo) as a percentage
	// of the picture's short side (text) or width (logo): 2..60.
	Size float64 `json:"size"`
}

// Options are Image Batch's per-submission options.
type Options struct {
	Resize    ResizeMode `json:"resize"`
	LongSide  int        `json:"longSide"`  // longSide: 16..20,000
	NoEnlarge bool       `json:"noEnlarge"` // longSide: never make a small picture bigger
	Width     int        `json:"width"`     // exact: 1..20,000
	Height    int        `json:"height"`    // exact: 1..20,000
	// Aspect crops or pads to a shape ("1:1", "4:5", "16:9", "9:16", "3:2",
	// "4:3"); "" keeps the shape. Ignored for exact sizes.
	Aspect     string    `json:"aspect"`
	Fit        Fit       `json:"fit"`
	Background string    `json:"background"` // pad colour: "#rrggbb" or "transparent"
	Format     Format    `json:"format"`
	Quality    int       `json:"quality"`   // JPEG and WebP: 1..100
	Strip      bool      `json:"strip"`     // drop EXIF, location and other metadata
	Watermark  Watermark `json:"watermark"` //
	// Name is the file name pattern: {name} the original name, {n} a running
	// number, {date} today (YYYY-MM-DD).
	Name string `json:"name"`
}

// Limits of Options.
const (
	MinSide    = 16
	MaxSide    = 20_000
	MaxName    = 200
	MaxWMText  = 200
	defaultWMS = 5
)

// Aspects are the shapes offered.
func Aspects() []string {
	return []string{"1:1", "4:5", "5:4", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"}
}

// DefaultOptions: 2048 px long side without enlarging, JPEG 85, metadata
// stripped, no watermark.
func DefaultOptions() Options {
	return Options{
		Resize: ResizeLongSide, LongSide: 2048, NoEnlarge: true, Width: 1080, Height: 1080,
		Fit: FitCrop, Background: "#ffffff", Format: FormatJPG, Quality: 85, Strip: true,
		Watermark: DefaultWatermark(), Name: "{name}",
	}
}

// DefaultWatermark: none; bottom right, 60%, 5% size when switched on.
func DefaultWatermark() Watermark {
	return Watermark{Kind: WatermarkNone, Font: "Arial", Color: "#ffffff", Corner: CornerBottomRight, Opacity: 0.6, Size: defaultWMS}
}

// FileResult is one finished picture in Result.
type FileResult struct {
	Input  string `json:"input"`
	Output string `json:"output"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Bytes  int64  `json:"bytes"`
}

// Result is a finished batch's result.
type Result struct {
	Files  []FileResult `json:"files"`
	Failed []string     `json:"failed"` // "name: why"
}
