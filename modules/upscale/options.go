package upscale

// Model selects an upscaling preset.
type Model string

const (
	ModelPhoto        Model = "photo"
	ModelIllustration Model = "illustration"
	ModelFast         Model = "fast"
)

// Format is the output image format.
type Format string

const (
	FormatSame Format = "same" // keep png/jpg/webp; HEIC → png
	FormatPNG  Format = "png"
	FormatJPG  Format = "jpg"
	FormatWebP Format = "webp"
)

// Device selects where the upscaling runs (SPEC §13.3).
type Device string

const (
	DeviceAuto Device = "auto" // GPU (upscayl-bin); CPU fallback when no GPU
	DeviceGPU  Device = "gpu"
	DeviceCPU  Device = "cpu" // AI engine (spandrel/torch)
)

// Limits.
const (
	MaxOutputPixels   = 100_000_000 // W·s × H·s
	MaxCPUInputPixels = 2_000_000
	LossyQuality      = 90
)

// Options are the Upscaler's per-submission options.
type Options struct {
	Model  Model  `json:"model"`
	Scale  int    `json:"scale"` // 2 | 4
	Format Format `json:"format"`
	Device Device `json:"device"`
}

// DefaultOptions: photo model, 4×, same format, automatic device.
func DefaultOptions() Options {
	return Options{Model: ModelPhoto, Scale: 4, Format: FormatSame, Device: DeviceAuto}
}

// Result is stored as the job's ResultJSON.
type Result struct {
	InWidth   int    `json:"inWidth"`
	InHeight  int    `json:"inHeight"`
	OutWidth  int    `json:"outWidth"`
	OutHeight int    `json:"outHeight"`
	Model     Model  `json:"model"`
	Scale     int    `json:"scale"`
	Device    string `json:"device"` // "gpu" | "cpu" | "mps"
	Bytes     int64  `json:"bytes"`
	Output    string `json:"output"` // absolute path
}
