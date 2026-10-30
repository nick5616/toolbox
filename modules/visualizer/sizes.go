package visualizer

import (
	"math"
	"path/filepath"
	"strconv"

	"toolbox/core"
)

// previewMs is the length of a preview (SPEC.md §7.1).
const previewMs = 10_000

// previewMaxShort caps a preview's short side at 1080p.
const previewMaxShort = 1080

// overlayMaxHeight caps the overlay render height (FFmpeg scales it back up).
const overlayMaxHeight = 1440

// minPlanSide is the smallest side the renderer accepts.
const minPlanSide = 320

func even(n int) int {
	if n%2 != 0 {
		n++
	}
	return n
}

// fullSize is the output size of full mode: the short side is height.
func fullSize(aspect string, height int) (w, h int) {
	switch aspect {
	case "9:16":
		return height, even(height * 16 / 9)
	case "1:1":
		return height, height
	case "4:5":
		return height, even(height * 5 / 4)
	default: // 16:9
		return even(height * 16 / 9), height
	}
}

// capShort scales w×h down (keeping the aspect, even sides) so the short side
// is at most limit.
func capShort(w, h, limit int) (int, int) {
	short := min(w, h)
	if short <= limit {
		return w, h
	}
	f := float64(limit) / float64(short)
	return even(int(math.Round(float64(w) * f))), even(int(math.Round(float64(h) * f)))
}

// overlaySizes returns the final size (the video's display size, even) and
// the render size (height at most 1440, sides at least 320).
func overlaySizes(vw, vh int) (finalW, finalH, planW, planH int) {
	finalW, finalH = even(max(vw, 2)), even(max(vh, 2))
	planW, planH = finalW, finalH
	if planH > overlayMaxHeight {
		f := float64(overlayMaxHeight) / float64(planH)
		planW, planH = even(int(math.Round(float64(planW)*f))), overlayMaxHeight
	}
	if s := min(planW, planH); s < minPlanSide {
		f := float64(minPlanSide) / float64(s)
		planW, planH = even(int(math.Ceil(float64(planW)*f))), even(int(math.Ceil(float64(planH)*f)))
	}
	return
}

var overlayFPS = []int{24, 25, 30, 50, 60}

// roundFPS maps a probed frame rate to the nearest of 24/25/30/50/60;
// unknown or variable (<= 0) becomes 30.
func roundFPS(fps float64) int {
	if fps <= 0 || math.IsNaN(fps) || math.IsInf(fps, 0) {
		return 30
	}
	best, bestD := 30, math.MaxFloat64
	for _, c := range overlayFPS {
		if d := math.Abs(fps - float64(c)); d < bestD {
			best, bestD = c, d
		}
	}
	return best
}

// renderRange resolves the media range of a job in ms. A preview is 10 s from
// previewStart (clamped into the media); a render is startMs..endMs with
// endMs 0 meaning the end. ok is false when the range is empty.
func renderRange(preview bool, startMs, endMs, previewStart, durationMs int64) (from, to int64, ok bool) {
	if durationMs <= 0 {
		return 0, 0, false
	}
	if preview {
		from = max(0, min(previewStart, durationMs-1000))
		to = min(from+previewMs, durationMs)
		return from, to, to > from
	}
	from, to = startMs, endMs
	if to <= 0 || to > durationMs {
		to = durationMs
	}
	return from, to, to > from
}

// partialRange says whether from..to is less than the whole media.
func partialRange(from, to, durationMs int64) bool {
	return from > 0 || to < durationMs
}

// chooseAudio is the audio file for the final mux. The original is the input;
// in overlay mode the original means the base video's own audio (""). The
// instrumental is the analysis' stem.
func chooseAudio(audio, input, instrumental string, overlay bool) string {
	if audio == "instrumental" && instrumental != "" {
		return instrumental
	}
	if overlay {
		return ""
	}
	return input
}

// outputName is the Library file stem for a render of input.
func outputName(input string) string {
	return core.StemName(input) + " (visualizer)"
}

// previewPath is where a job's preview is written.
func previewPath(dir, jobID string) string {
	return filepath.Join(dir, "preview-"+jobID+".mp4")
}

// secs formats ms as ffmpeg seconds.
func secs(ms int64) string { return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64) }
