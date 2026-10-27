package downloader

// Mode selects audio extraction or video download.
type Mode string

const (
	ModeAudio Mode = "audio"
	ModeVideo Mode = "video"
)

// AudioFormat is the target audio container/codec.
type AudioFormat string

const (
	FormatMP3  AudioFormat = "mp3"
	FormatWAV  AudioFormat = "wav"
	FormatFLAC AudioFormat = "flac"
)

// AudioQuality applies to mp3 only. "best" is VBR V0.
type AudioQuality string

const (
	QualityBest AudioQuality = "best"
	Quality320  AudioQuality = "320"
	Quality256  AudioQuality = "256"
	Quality192  AudioQuality = "192"
	Quality128  AudioQuality = "128"
)

// MaxResolution caps video height. "best" means no cap.
type MaxResolution string

const (
	ResBest MaxResolution = "best"
	Res2160 MaxResolution = "2160"
	Res1440 MaxResolution = "1440"
	Res1080 MaxResolution = "1080"
	Res720  MaxResolution = "720"
	Res480  MaxResolution = "480"
	Res360  MaxResolution = "360"
)

// Options are the downloader's per-submission options.
type Options struct {
	Mode          Mode          `json:"mode"`
	AudioFormat   AudioFormat   `json:"audioFormat"`
	AudioQuality  AudioQuality  `json:"audioQuality"`
	MaxResolution MaxResolution `json:"maxResolution"`
	TrimEnabled   bool          `json:"trimEnabled"`
	// TrimStart/TrimEnd are timecodes ("SS[.fff]", "M:SS", "H:MM:SS[.fff]").
	// "" means start of media / end of media.
	TrimStart      string `json:"trimStart"`
	TrimEnd        string `json:"trimEnd"`
	EmbedMetadata  bool   `json:"embedMetadata"`
	EmbedThumbnail bool   `json:"embedThumbnail"`
	Playlist       bool   `json:"playlist"`
}

// DefaultOptions are used when the UI has no saved state.
func DefaultOptions() Options {
	return Options{
		Mode:           ModeAudio,
		AudioFormat:    FormatMP3,
		AudioQuality:   Quality320,
		MaxResolution:  Res1080,
		EmbedMetadata:  true,
		EmbedThumbnail: true,
	}
}
