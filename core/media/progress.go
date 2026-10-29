package media

import (
	"fmt"
	"strconv"
	"strings"

	"toolbox/core"
)

// ProgressTracker folds ffmpeg "-progress pipe:1" key=value lines into
// progress updates. A block of lines ends with progress=continue|end.
type ProgressTracker struct {
	// Duration is the expected output length in seconds; <= 0 means unknown.
	Duration float64
	// Label names the work in messages ("Converting"); "" = "Converting".
	Label string

	outTime float64
	speed   float64 // 0 = unknown
}

// Apply consumes one line. changed is true when a block ended (or the run
// finished) and pct/msg should be reported.
func (t *ProgressTracker) Apply(line string) (pct float64, msg string, changed bool) {
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

func (t *ProgressTracker) snapshot() (float64, string) {
	if t.Duration <= 0 {
		return core.IndeterminateProgress, t.label() + "…"
	}
	pct := min(t.outTime/t.Duration, 0.99)
	if t.speed <= 0 {
		return pct, t.label() + "…"
	}
	return pct, fmt.Sprintf("%s · %.1f× · ETA %s", t.label(), t.speed, formatETA((t.Duration-t.outTime)/t.speed))
}

func (t *ProgressTracker) label() string {
	if t.Label == "" {
		return "Converting"
	}
	return t.Label
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
