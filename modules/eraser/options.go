package eraser

// Model picks the inpainting model (SPEC.md §9.1).
type Model string

const (
	ModelBest Model = "best" // LaMa, 208 MB
	ModelFast Model = "fast" // MI-GAN, 28 MB
)

// Options are Object Eraser's per-submission options.
type Options struct {
	Model    Model  `json:"model"`
	MaskPath string `json:"maskPath"` // set by Service.Erase; never from the UI
}

// DefaultOptions: the best model.
func DefaultOptions() Options { return Options{Model: ModelBest} }

// ModelInfo describes a model choice for the UI.
type ModelInfo struct {
	ID            Model  `json:"id"`
	Label         string `json:"label"`
	DownloadBytes int64  `json:"downloadBytes"`
	Present       bool   `json:"present"`
}

// Result is a job's result.
type Result struct {
	Regions int      `json:"regions"`
	Warning string   `json:"warning"` // e.g. "Large areas may look smeared"
	Outputs []string `json:"outputs"`
}
