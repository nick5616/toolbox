package trimmer

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
)

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if len(inputs) != 1 {
		return core.ValidationError("Choose one file to trim", nil)
	}
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if err := validateShape(opts); err != nil {
		return err
	}
	ffprobe, err := m.resolve("ffprobe")
	if err != nil {
		return err
	}
	info, err := media.Probe(context.Background(), ffprobe, inputs[0])
	if err != nil {
		return err
	}
	return validateAgainst(opts, info)
}

func fieldErr(msg, field string) error {
	return core.ValidationError(msg, map[string]string{field: msg})
}

// validateShape checks everything that doesn't need the probed file.
func validateShape(o Options) error {
	switch o.Mode {
	case ModeFast, ModePrecise:
	default:
		return fieldErr("Choose Fast or Precise", "mode")
	}
	switch o.Join {
	case JoinMerge, JoinSeparate:
	default:
		return fieldErr("Choose how to join the segments", "join")
	}
	switch o.Aspect {
	case AspectKeep, AspectPortrait, AspectSquare, AspectFourFive, AspectWide:
	default:
		return fieldErr("Choose a valid frame shape", "aspect")
	}
	if o.CropX < 0 || o.CropX > 1 || o.CropY < 0 || o.CropY > 1 {
		return fieldErr("The crop position is outside the frame", "cropX")
	}
	if o.MaxSizeMB != 0 && (o.MaxSizeMB < 1 || o.MaxSizeMB > 4000) {
		return fieldErr("The size limit must be between 1 and 4000 MB", "maxSizeMB")
	}
	if !slices.Contains([]int{0, 2160, 1440, 1080, 720, 480}, o.MaxHeight) {
		return fieldErr("Choose a valid maximum height", "maxHeight")
	}
	if n := len(o.Segments); n < 1 || n > maxSegments {
		return fieldErr(fmt.Sprintf("Keep between 1 and %d segments", maxSegments), "segments")
	}
	for i, s := range o.Segments {
		if s.EndMs-s.StartMs < minSegmentMs {
			return fieldErr(fmt.Sprintf("Segment %d is shorter than 0.1 seconds", i+1), "segments")
		}
		if s.StartMs < 0 {
			return fieldErr(fmt.Sprintf("Segment %d starts before the beginning", i+1), "segments")
		}
		if i > 0 && s.StartMs < o.Segments[i-1].EndMs {
			return fieldErr(fmt.Sprintf("Segment %d overlaps the one before it", i+1), "segments")
		}
	}
	if o.Mode == ModeFast && (o.Aspect != AspectKeep || o.MaxSizeMB > 0 || o.MaxHeight > 0) {
		return fieldErr("Cropping, resizing and size limits need Precise mode", "mode")
	}
	return nil
}

// validateAgainst checks the options against the probed file.
func validateAgainst(o Options, info media.Info) error {
	if err := validateShape(o); err != nil {
		return err
	}
	if last := o.Segments[len(o.Segments)-1]; last.EndMs > info.DurationMs {
		return fieldErr("A segment ends after the end of the file", "segments")
	}
	hasVideo := info.Video != nil
	if !hasVideo {
		switch {
		case o.Aspect != AspectKeep:
			return fieldErr("Cropping needs a video", "aspect")
		case o.MaxHeight > 0:
			return fieldErr("Resizing needs a video", "maxHeight")
		case o.MaxSizeMB > 0:
			return fieldErr("Size limits need a video", "maxSizeMB")
		case o.RemoveAudio:
			return fieldErr("There's no video to keep once the audio is removed", "removeAudio")
		}
	}
	if o.MaxSizeMB > 0 {
		for _, d := range sizeDurations(o) {
			if videoBitrateKbps(o.MaxSizeMB, audioRateFor(o, info), d) < minVideoKbps {
				return fieldErr(fmt.Sprintf("That's too long to fit in %d MB; raise the limit or trim more", o.MaxSizeMB), "maxSizeMB")
			}
		}
	}
	return nil
}

// audioRateFor is the audio bit rate reserved in the size budget.
func audioRateFor(o Options, info media.Info) float64 {
	if o.RemoveAudio || len(info.Audio) == 0 {
		return 0
	}
	return audioBps
}

// sizeDurations are the output lengths (s) the limit applies to: the total
// when merged, each segment when separate.
func sizeDurations(o Options) []float64 {
	if o.Join == JoinSeparate {
		var d []float64
		for _, s := range o.Segments {
			d = append(d, float64(s.EndMs-s.StartMs)/1000)
		}
		return d
	}
	return []float64{float64(totalMs(o.Segments)) / 1000}
}
