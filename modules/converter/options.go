package converter

// Preset is a conversion target (see presets.go).
type Preset string

// MaxHeight caps video height for video presets ("keep" = unchanged).
type MaxHeight string

const (
	HeightKeep MaxHeight = "keep"
	Height2160 MaxHeight = "2160"
	Height1440 MaxHeight = "1440"
	Height1080 MaxHeight = "1080"
	Height720  MaxHeight = "720"
	Height480  MaxHeight = "480"
)

// Options are the Converter's per-submission options.
type Options struct {
	Preset       Preset    `json:"preset"`
	MaxHeight    MaxHeight `json:"maxHeight"`
	KeepMetadata bool      `json:"keepMetadata"`
}

// DefaultOptions: MP3 320, keep size, keep metadata.
func DefaultOptions() Options {
	return Options{Preset: "mp3-320", MaxHeight: HeightKeep, KeepMetadata: true}
}
