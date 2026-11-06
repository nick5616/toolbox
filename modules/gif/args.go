package gif

import (
	"fmt"
	"strconv"

	"toolbox/core/media"
)

func commonArgs() []string {
	return []string{"-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"}
}

func secsF(sec float64) string { return strconv.FormatFloat(sec, 'f', 3, 64) }

// loopFilter picks the frames at fps and scales to width (never above the
// source width); the height follows, kept even.
func loopFilter(fps, width int) string {
	return fmt.Sprintf("fps=%d,scale=w='min(%d,iw)':h=-2:flags=lanczos", fps, width)
}

// paletteArgs makes the colour palette of the part [startSec, +lengthSec).
func paletteArgs(in, palette string, startSec, lengthSec float64, fps, width int) []string {
	return append(commonArgs(), "-ss", secsF(startSec), "-t", secsF(lengthSec), "-i", in,
		"-map", "0:v:0", "-an", "-vf", loopFilter(fps, width)+",palettegen=stats_mode=diff",
		"-update", "1", palette)
}

// gifArgs draws the GIF with that palette.
func gifArgs(in, palette, out string, startSec, lengthSec float64, fps, width int, loop bool) []string {
	loopN := "-1" // the GIF muxer: -1 plays once, 0 forever
	if loop {
		loopN = "0"
	}
	return append(commonArgs(), "-ss", secsF(startSec), "-t", secsF(lengthSec), "-i", in, "-i", palette,
		"-an", "-filter_complex", "[0:v:0]"+loopFilter(fps, width)+"[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[o]",
		"-map", "[o]", "-loop", loopN, out)
}

// webpArgs makes an animated WebP.
func webpArgs(in, out string, startSec, lengthSec float64, fps, width int, loop bool) []string {
	loopN := "1" // libwebp_anim: 0 forever, N times
	if loop {
		loopN = "0"
	}
	return append(commonArgs(), "-ss", secsF(startSec), "-t", secsF(lengthSec), "-i", in,
		"-map", "0:v:0", "-an", "-vf", loopFilter(fps, width),
		"-c:v", "libwebp_anim", "-lossless", "0", "-quality", "75", "-compression_level", "4", "-loop", loopN, out)
}

// tileTimes are the moments the n frames of a sheet are taken: the middle of
// n equal slices of the video.
func tileTimes(durationMs int64, n int) []int64 {
	out := make([]int64, n)
	for i := range out {
		out[i] = durationMs * int64(2*i+1) / int64(2*n)
	}
	return out
}

// cellSize is the size of one sheet frame for a source of w × h, both even.
func cellSize(cellWidth, w, h int) (cw, ch int) {
	cw = cellWidth &^ 1
	if w <= 0 || h <= 0 {
		return cw, (cw * 9 / 16) &^ 1
	}
	ch = (cw * h / w) &^ 1
	return cw, max(ch, 2)
}

// frameArgs grabs one frame at atSec scaled to cw × ch; label, when set, is
// the name of an ASS file in FFmpeg's working directory burned onto it.
func frameArgs(in, out string, atSec float64, cw, ch int, label string) []string {
	vf := fmt.Sprintf("scale=%d:%d:flags=lanczos", cw, ch)
	if label != "" {
		vf += ",ass=" + label
	}
	return append(commonArgs(), "-ss", secsF(atSec), "-i", in, "-map", "0:v:0", "-an", "-frames:v", "1", "-vf", vf, out)
}

// sheetArgs tiles frames named pattern (t%03d.png from 1) into a JPG. Run in
// the directory holding the frames.
func sheetArgs(pattern, out string, cols, rows int) []string {
	return append(commonArgs(), "-framerate", "1", "-start_number", "1", "-i", pattern,
		"-vf", fmt.Sprintf("tile=%dx%d:padding=6:margin=6:color=0x151515", cols, rows),
		"-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "2", out)
}

// timecode formats ms as m:ss, or h:mm:ss from an hour on.
func timecode(ms int64) string {
	s := ms / 1000
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s%3600/60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

// labelDoc is the one-line ASS script that burns a timecode into a cw × ch frame.
func labelDoc(text string, cw, ch int) media.ASSDoc {
	size := max(10, float64(ch)*0.085)
	return media.ASSDoc{
		PlayResX: cw, PlayResY: ch,
		Styles: []media.ASSStyle{{
			Name: "Tc", Font: media.DefaultFont, Size: size,
			Primary: "#FFFFFF", Secondary: "#FFFFFF", Outline: "#000000", Back: "#000000", BackAlpha: 90,
			Bold: true, BorderStyle: 3, OutlineWidth: size * 0.12, Alignment: 1, MarginL: 4, MarginR: 4, MarginV: 4,
		}},
		Events: []media.ASSEvent{{StartMs: 0, EndMs: 600_000, Style: "Tc", Text: media.ASSEscape(text)}},
	}
}
