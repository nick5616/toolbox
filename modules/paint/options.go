package paint

// ExportFormat is an export file type.
type ExportFormat string

const (
	FormatPNG  ExportFormat = "png"
	FormatJPG  ExportFormat = "jpg"
	FormatWebP ExportFormat = "webp"
	FormatORA  ExportFormat = "ora"
)

// ExportOptions are an export's settings (SPEC.md §2.6). They are also the
// options of an export job.
type ExportOptions struct {
	ProjectID string       `json:"projectId"`
	Format    ExportFormat `json:"format"`
	Quality   int          `json:"quality"` // JPG/WebP 60..100
	Scale     float64      `json:"scale"`   // 0.25..4
	Name      string       `json:"name"`    // "" = the project name
	// Flattened is a PNG data URL the frontend rendered when the canvas uses
	// blend modes outside GoBlends (ORA keeps layers and ignores it).
	Flattened string `json:"flattened"`
}

// DefaultExportOptions is PNG at 100%.
func DefaultExportOptions() ExportOptions {
	return ExportOptions{Format: FormatPNG, Quality: 92, Scale: 1}
}

// AIPoint is a Select object click in crop pixels.
type AIPoint struct {
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Positive bool    `json:"positive"`
}

// AIOp is a perception tool operation.
type AIOp string

const (
	OpFill    AIOp = "fill"
	OpCutout  AIOp = "cutout"
	OpSegment AIOp = "segment"
	OpEnhance AIOp = "enhance"
)

// AIRequest is one perception tool call on a crop (SPEC.md §2.5).
type AIRequest struct {
	Op       AIOp      `json:"op"`
	Source   string    `json:"source"` // PNG data URL of the crop (≤ MaxAICropBytes)
	Mask     string    `json:"mask"`   // PNG data URL (fill), "" otherwise
	Points   []AIPoint `json:"points"` // segment, ≤ 64
	Model    string    `json:"model"`  // fill: best|fast; cutout: fast|balanced|best; enhance: preset ID
	Passes   int       `json:"passes"` // fill: 1..12
	Ghost    float64   `json:"ghost"`  // 0..1
	Drift    float64   `json:"drift"`  // 0..1
	DriftDir string    `json:"driftDir"`
	Offset   [2]int    `json:"offset"` // Echo fill source offset (crop px)
	Seed     int64     `json:"seed"`
	Scale    int       `json:"scale"` // enhance: 2|4
}

// AIResultInfo is a paint-ai job's result JSON.
type AIResultInfo struct {
	Op     AIOp    `json:"op"`
	Passes int     `json:"passes"` // fill: passes produced (AIResult index 1..Passes)
	Score  float64 `json:"score"`  // segment
	Width  int     `json:"width"`  // result size (crop px)
	Height int     `json:"height"`
}

// AIModelInfo says whether a perception tool can run here (drives the gates).
type AIModelInfo struct {
	Tool      string   `json:"tool"`      // fill | cutout | segment | enhance
	Ready     bool     `json:"ready"`     // engine + model present
	Needs     []string `json:"needs"`     // missing pack component IDs
	Reason    string   `json:"reason"`    // "" when ready
	ModelSize int64    `json:"modelSize"` // download size when missing, 0 when present
}

// StepAction is what the pipeline step does.
type StepAction string

const (
	StepOverlay  StepAction = "overlay"  // draw a saved painting over each image
	StepDissolve StepAction = "dissolve" // Dissolve each image with a mask
)

// StepOptions are Paint+'s pipeline step options (SPEC.md §2.7). They are
// also the options of a step job.
type StepOptions struct {
	Action  StepAction `json:"action"`
	Project string     `json:"project"` // Paint+ project ID (overlay source / mask source)
	Layer   string     `json:"layer"`   // dissolve: the project's layer whose alpha is the mask ("" = use Mask)
	Mask    string     `json:"mask"`    // dissolve: an Object Eraser saved mask ID (when Layer is "")
	Fit     string     `json:"fit"`     // overlay: contain | cover | stretch
	Passes  int        `json:"passes"`
	Ghost   float64    `json:"ghost"`
	Drift   float64    `json:"drift"`
	Seed    int64      `json:"seed"`
	Model   string     `json:"model"` // best | fast
}

// DefaultStepOptions start as an overlay.
func DefaultStepOptions() StepOptions {
	return StepOptions{Action: StepOverlay, Fit: "contain", Passes: 6, Ghost: 0.3, Drift: 0.5, Seed: 1, Model: "fast"}
}

// BrushInfo describes one brush in a set.
type BrushInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Set     string `json:"set"`
	Credit  string `json:"credit"`  // "" for our own
	License string `json:"license"` // "" for our own
}

// BrushSet is a user brush set on disk (imported, or made in Brush Studio).
type BrushSet struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	Source   string      `json:"source"` // procreate | mypaint | abr | krita | paintplus | user
	Brushes  []BrushInfo `json:"brushes"`
	Imported int64       `json:"imported"` // Unix ms
}

// BrushImportResult reports one imported file.
type BrushImportResult struct {
	File     string   `json:"file"`
	Set      BrushSet `json:"set"`
	Fidelity []string `json:"fidelity"` // what was approximated or skipped
	Error    string   `json:"error"`    // "" on success
}

// Origin is a Lab tool's origin card (SPEC.md §1.4.3).
type Origin struct {
	Model     string `json:"model"`
	UsedBy    string `json:"usedBy"`
	License   string `json:"license"`
	TrainedOn string `json:"trainedOn"`
	Generates string `json:"generates"`
	Source    string `json:"source"` // paper / model card URL
}
