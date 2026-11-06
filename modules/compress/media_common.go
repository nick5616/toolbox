package compress

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
)

// partRange is one equal-length time range of a split.
type partRange struct{ StartMs, DurMs int64 }

// splitRanges cuts durMs into n equal-length ranges.
func splitRanges(durMs int64, n int) []partRange {
	if n <= 1 {
		return []partRange{{0, durMs}}
	}
	out := make([]partRange, n)
	for i := 0; i < n; i++ {
		s := durMs * int64(i) / int64(n)
		e := durMs * int64(i+1) / int64(n)
		out[i] = partRange{s, e - s}
	}
	return out
}

// partDur is the longest part's duration when durMs is cut into n parts.
func partDur(durMs int64, n int) int64 { return (durMs + int64(n) - 1) / int64(n) }

// attemptSpan maps encode attempt k (0-based) to its share of a part's
// progress range: the first attempt is most of the bar, retries squeeze into
// what is left.
func attemptSpan(k int) (from, to float64) {
	switch k {
	case 0:
		return 0, 0.7
	case 1:
		return 0.7, 0.9
	}
	return 0.9, 1
}

// subRange maps a..b (0..1) into [from,to].
func subRange(from, to, a, b float64) (float64, float64) {
	return from + (to-from)*a, from + (to-from)*b
}

// mapEncoderError turns FFmpeg's "Unknown encoder" into advice.
func mapEncoderError(err error, encoder string) error {
	var ae *core.AppError
	if errors.As(err, &ae) && strings.Contains(ae.Message, "Unknown encoder") {
		return core.Errorf(core.CodeToolFailed, "This FFmpeg can't encode %s", encoder).
			WithHint("Choose H.264, or reinstall FFmpeg from Settings").WithCause(err)
	}
	return err
}

// probeFile probes path with ffprobe, mapping failures to a short problem text.
func probeFile(ctx context.Context, tool toolFunc, path string) (media.Info, string) {
	probe, err := tool("ffprobe")
	if err != nil {
		return media.Info{}, "Needs FFmpeg: install the Media pack"
	}
	info, err := media.Probe(ctx, probe, path)
	if err != nil {
		return media.Info{}, "Can't read this file"
	}
	if info.DurationMs <= 0 {
		return info, "Can't tell how long this is"
	}
	return info, ""
}

// formatKbps writes a bitrate: "800 kb/s", "1.4 Mb/s".
func formatKbps(kbps int) string {
	if kbps >= 1000 {
		return strconv.FormatFloat(math.Round(float64(kbps)/100)/10, 'f', -1, 64) + " Mb/s"
	}
	return fmt.Sprintf("%d kb/s", kbps)
}

func partsPrefix(parts int) string {
	if parts > 1 {
		return fmt.Sprintf("%d parts · ", parts)
	}
	return ""
}

// gradeRank orders grades (poor lowest).
func gradeRank(g Grade) int {
	switch g {
	case GradeGreat:
		return 3
	case GradeGood:
		return 2
	case GradeFair:
		return 1
	}
	return 0
}

// atLeastFair reports whether g is fair or better.
func atLeastFair(g Grade) bool { return gradeRank(g) >= 1 }
