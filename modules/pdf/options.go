package pdf

// Action is the PDF operation a job performs.
type Action string

const (
	ActionMerge       Action = "merge"
	ActionSplit       Action = "split"
	ActionOrganize    Action = "organize"
	ActionCompress    Action = "compress"
	ActionImagesToPDF Action = "images-to-pdf"
	ActionPDFToImages Action = "pdf-to-images"
	ActionProtect     Action = "protect"
	ActionUnlock      Action = "unlock"
)

// AllActions lists the actions in UI order.
func AllActions() []Action {
	return []Action{ActionMerge, ActionSplit, ActionOrganize, ActionCompress,
		ActionImagesToPDF, ActionPDFToImages, ActionProtect, ActionUnlock}
}

// Split modes.
const (
	SplitEvery  = "every"
	SplitRanges = "ranges"
)

// Compression levels (SPEC §6.4 table).
const (
	LevelSmall    = "small"
	LevelBalanced = "balanced"
	LevelHigh     = "high"
)

// Page sizes for images → PDF.
const (
	PageA4     = "a4"
	PageLetter = "letter"
	PageFit    = "fit"
)

// Margins for images → PDF.
const (
	MarginNone  = "none"
	MarginSmall = "small"
)

// Image formats for PDF → images.
const (
	ImagePNG = "png"
	ImageJPG = "jpg"
)

// Limits.
const (
	MaxInputBytes = 500 << 20
)

// PageEdit is one output page of an organize job.
type PageEdit struct {
	Page   int `json:"page"`   // 1-based source page
	Rotate int `json:"rotate"` // 0 | 90 | 180 | 270, clockwise, added to the page's rotation
}

// Options are the PDF Toolkit's per-submission options. Passwords never
// appear here: they live in memory and are referenced by PasswordRef.
type Options struct {
	Action Action `json:"action"`

	// split
	SplitMode string `json:"splitMode"` // "every" | "ranges"
	Every     int    `json:"every"`     // ≥ 1
	Ranges    string `json:"ranges"`    // "1-3, 5, 8-"; each range → one file

	// organize (single input): the output pages, in order
	Pages []PageEdit `json:"pages"`

	// compress
	Level string `json:"level"` // "small" | "balanced" | "high"

	// images-to-pdf
	PageSize string `json:"pageSize"` // "a4" | "letter" | "fit"
	Margin   string `json:"margin"`   // "none" | "small"

	// pdf-to-images
	ImageFormat string `json:"imageFormat"` // "png" | "jpg"
	DPI         int    `json:"dpi"`         // 72 | 150 | 300
	PageRange   string `json:"pageRange"`   // "" = all, else ranges syntax

	// set by the service; opaque ID of an in-memory secret
	PasswordRef string `json:"passwordRef"`
}

// DefaultOptions returns defaults for every action (merge selected).
func DefaultOptions() Options {
	return Options{
		Action: ActionMerge, SplitMode: SplitEvery, Every: 1, Pages: []PageEdit{},
		Level: LevelBalanced, PageSize: PageA4, Margin: MarginSmall,
		ImageFormat: ImagePNG, DPI: 150,
	}
}

// PageSize is a page's size in PDF points (1/72 in), after rotation.
type PageSize struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Info describes a PDF for the UI.
type Info struct {
	Path          string     `json:"path"`
	Pages         int        `json:"pages"`
	Encrypted     bool       `json:"encrypted"`
	NeedsPassword bool       `json:"needsPassword"` // can't open without a user password
	Restricted    bool       `json:"restricted"`    // owner-password permissions block edits
	Title         string     `json:"title"`
	PageSizes     []PageSize `json:"pageSizes"`
	Bytes         int64      `json:"bytes"`
	HasBookmarks  bool       `json:"hasBookmarks"`
}

// Result is stored as the job's ResultJSON.
type Result struct {
	Action             Action   `json:"action"`
	Outputs            []string `json:"outputs"` // absolute paths (pdf-to-images: the image files)
	Folder             string   `json:"folder"`  // pdf-to-images: the subfolder holding the images
	Pages              int      `json:"pages"`   // pages in the output (merge/organize/images-to-pdf) or rendered
	BytesBefore        int64    `json:"bytesBefore"`
	BytesAfter         int64    `json:"bytesAfter"`
	ImagesRecompressed int      `json:"imagesRecompressed"`
	BookmarksDropped   bool     `json:"bookmarksDropped"`
}
