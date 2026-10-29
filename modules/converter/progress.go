package converter

import (
	"strconv"
	"strings"
)

// parseDuration parses ffprobe's format=duration output; 0 when unknown.
func parseDuration(out string) float64 {
	out = strings.TrimSpace(out)
	if i := strings.IndexAny(out, "\r\n"); i >= 0 {
		out = out[:i]
	}
	v, err := strconv.ParseFloat(out, 64)
	if err != nil || v <= 0 || v != v {
		return 0
	}
	return v
}
