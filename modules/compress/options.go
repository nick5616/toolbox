package compress

import (
	"math"

	"toolbox/core"
)

// TooSmall is what happens when a file can't look decent at the target size.
type TooSmall string

const (
	// TooSmallLower lowers the quality as far as needed (down to the floors).
	TooSmallLower TooSmall = "lower"
	// TooSmallSplit splits video and audio into parts that each fit.
	TooSmallSplit TooSmall = "split"
)

// VideoCodec is the video encoder.
type VideoCodec string

const (
	CodecH264 VideoCodec = "h264" // plays everywhere; Discord embeds it
	CodecH265 VideoCodec = "h265" // smaller at the same quality, plays in fewer places
)

// ImageFormat is the output format of photos.
type ImageFormat string

const (
	ImageAuto ImageFormat = "auto" // JPEG if opaque, WebP if transparent (PNG without FFmpeg)
	ImageJPEG ImageFormat = "jpeg"
	ImageWebP ImageFormat = "webp"
	ImageKeep ImageFormat = "keep" // the input's own format (JPEG/PNG/WebP)
)

// Kind is how a file is compressed.
type Kind string

const (
	KindVideo  Kind = "video"
	KindAudio  Kind = "audio"
	KindImage  Kind = "image"
	KindGIF    Kind = "gif"
	KindPDF    Kind = "pdf"
	KindOffice Kind = "office" // .docx/.pptx/.xlsx: their pictures are recompressed
	KindOther  Kind = "other"  // zipped
)

// Grade is how a result looks at its size ("" = not applicable).
type Grade string

const (
	GradeGreat Grade = "great"
	GradeGood  Grade = "good"
	GradeFair  Grade = "fair"
	GradePoor  Grade = "poor"
	GradeNone  Grade = ""
)

// CustomTarget is the TargetID of a size the user typed.
const CustomTarget = "custom"

// Options are Compress to Size's per-submission options (also its step options).
type Options struct {
	TargetID     string      `json:"targetId"`     // a Target ID or "custom"
	TargetMB     float64     `json:"targetMb"`     // the limit when TargetID == "custom" (1 MB = 1,000,000 bytes)
	IfTooSmall   TooSmall    `json:"ifTooSmall"`   // when it can't look decent at that size
	VideoCodec   VideoCodec  `json:"videoCodec"`   //
	MaxHeight    int         `json:"maxHeight"`    // 0 = auto; else a cap on the video height
	KeepAudio    bool        `json:"keepAudio"`    // video: keep the sound
	ImageFormat  ImageFormat `json:"imageFormat"`  //
	KeepMetadata bool        `json:"keepMetadata"` // keep location/camera data (dropped by default)
}

// Limits of Options.
const (
	MinTargetMB = 0.05
	MaxTargetMB = 100_000
	// MaxParts caps how many parts a split makes.
	MaxParts = 50
)

// MaxHeights are the allowed MaxHeight values (0 = auto).
var MaxHeights = []int{0, 2160, 1440, 1080, 720, 480, 360}

// DefaultOptions: Discord, lower the quality when needed, H.264, keep the sound.
func DefaultOptions() Options {
	return Options{
		TargetID: "discord", TargetMB: 20, IfTooSmall: TooSmallLower, VideoCodec: CodecH264,
		MaxHeight: 0, KeepAudio: true, ImageFormat: ImageAuto, KeepMetadata: false,
	}
}

// Validate checks every field.
func (o Options) Validate() error {
	fields := map[string]string{}
	if o.TargetID == CustomTarget {
		if math.IsNaN(o.TargetMB) || o.TargetMB < MinTargetMB || o.TargetMB > MaxTargetMB {
			fields["targetMb"] = "Choose a size between 0.05 MB and 100,000 MB"
		}
	} else if _, ok := TargetByID(o.TargetID); !ok {
		fields["targetId"] = "Choose where the file is going"
	}
	switch o.IfTooSmall {
	case TooSmallLower, TooSmallSplit:
	default:
		fields["ifTooSmall"] = "Choose what to do when it can't look good"
	}
	switch o.VideoCodec {
	case CodecH264, CodecH265:
	default:
		fields["videoCodec"] = "Choose H.264 or H.265"
	}
	okHeight := false
	for _, h := range MaxHeights {
		if o.MaxHeight == h {
			okHeight = true
		}
	}
	if !okHeight {
		fields["maxHeight"] = "Choose a video height"
	}
	switch o.ImageFormat {
	case ImageAuto, ImageJPEG, ImageWebP, ImageKeep:
	default:
		fields["imageFormat"] = "Choose a photo format"
	}
	if len(fields) > 0 {
		for _, msg := range fields {
			return core.ValidationError(msg, fields)
		}
	}
	return nil
}

// Limit is the size every output must stay at or under, in bytes.
func (o Options) Limit() int64 {
	if o.TargetID != CustomTarget {
		if t, ok := TargetByID(o.TargetID); ok {
			return t.Bytes
		}
	}
	return int64(math.Round(o.TargetMB * 1_000_000))
}

// TargetLabel names the target for summaries ("Discord", "15 MB").
func (o Options) TargetLabel() string {
	if o.TargetID != CustomTarget {
		if t, ok := TargetByID(o.TargetID); ok {
			return t.Label
		}
	}
	return FormatBytes(o.Limit())
}

// Budget is the byte size a run aims at: 97% of the limit.
func Budget(limit int64) int64 { return limit * 97 / 100 }

// MaxAttempts caps encodes per file (or part) when a result lands over the limit.
const MaxAttempts = 3

// Estimate is what compressing one file would do (Service.Estimate).
type Estimate struct {
	Path          string `json:"path"`
	Name          string `json:"name"`
	Kind          Kind   `json:"kind"`
	OriginalBytes int64  `json:"originalBytes"`
	LimitBytes    int64  `json:"limitBytes"`
	AlreadyFits   bool   `json:"alreadyFits"`
	Possible      bool   `json:"possible"` // it can get under the limit with these options
	Plan          string `json:"plan"`     // "1080p → 720p · 30 fps · H.264 1.4 Mb/s · AAC 96 kb/s"
	Grade         Grade  `json:"grade"`
	Parts         int    `json:"parts"`   // > 1 when it would be split
	Note          string `json:"note"`    // e.g. "PDF results depend on its pictures"
	Problem       string `json:"problem"` // can't read it, encrypted, FFmpeg missing, …
}

// Result is one finished file.
type Result struct {
	Input         string   `json:"input"`
	Kind          Kind     `json:"kind"`
	Outputs       []string `json:"outputs"` // one file, or the parts in order
	OriginalBytes int64    `json:"originalBytes"`
	FinalBytes    int64    `json:"finalBytes"` // the largest output
	TotalBytes    int64    `json:"totalBytes"` // all outputs together
	LimitBytes    int64    `json:"limitBytes"`
	Fits          bool     `json:"fits"`
	AlreadyFit    bool     `json:"alreadyFit"`
	Plan          string   `json:"plan"`
	Grade         Grade    `json:"grade"`
	Attempts      int      `json:"attempts"`
	Parts         int      `json:"parts"`
}
