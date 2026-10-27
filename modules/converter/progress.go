package converter

import (
	"fmt"
	"strconv"
	"strings"

	"toolbox/core"
)

// progressTracker folds ffmpeg "-progress pipe:1" key=value lines into
// progress updates. A block of lines ends with progress=continue|end.
type progressTracker struct {
	duration float64 // seconds; <= 0 means unknown
	outTime  float64
	speed    float64 // 0 = unknown
}

// apply consumes one line. changed is true when a block ended (or the run
// finished) and pct/msg should be reported.
func (t *progressTracker) apply(line string) (pct float64, msg string, changed bool) {
	key, val, ok := strings.Cut(strings.TrimSpace(line), "=")
	if !ok {
		return 0, "", false
	}
	val = strings.TrimSpace(val)
	switch key {
	case "out_time_us":
		if v, err := strconv.ParseFloat(val, 64); err == nil && v >= 0 {
			t.outTime = v / 1e6
		}
	case "speed":
		t.speed = 0
		if v, err := strconv.ParseFloat(strings.TrimSuffix(val, "x"), 64); err == nil && v > 0 {
			t.speed = v
		}
	case "progress":
		if val == "end" {
			return 1, "Finishing…", true
		}
		pct, msg = t.snapshot()
		return pct, msg, true
	}
	return 0, "", false
}

func (t *progressTracker) snapshot() (float64, string) {
	if t.duration <= 0 {
		return core.IndeterminateProgress, "Converting…"
	}
	pct := min(t.outTime/t.duration, 0.99)
	if t.speed <= 0 {
		return pct, "Converting…"
	}
	return pct, fmt.Sprintf("Converting · %.1f× · ETA %s", t.speed, formatETA((t.duration-t.outTime)/t.speed))
}

func formatETA(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	s := int(sec + 0.5)
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s%3600/60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

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
