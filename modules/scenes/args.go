package scenes

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	scoresFile = "scores.txt" // written by metadata=print, relative to the job's TempDir
	// keyframeTolMs is how far a scene start may sit from a keyframe and
	// still be cut by stream copy.
	keyframeTolMs = 80
)

func secs(ms int64) string { return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64) }

func commonArgs() []string {
	return []string{"-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"}
}

// detectFilter scores every frame (downscaled, so long videos stay quick);
// the scores land in scoresFile in FFmpeg's working directory.
func detectFilter() string {
	return "scale=320:-2,select='gte(scene,0)',metadata=print:file=" + scoresFile
}

// detectArgs scores the frames of in. Run with the job's TempDir as the
// working directory, so the filter never holds a Windows path.
func detectArgs(in string) []string {
	return append(commonArgs(), "-i", in, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", detectFilter(), "-f", "null", "-")
}

// copyClipArgs cuts [startMs, endMs] without re-encoding.
func copyClipArgs(in, out string, startMs, endMs int64) []string {
	return append(commonArgs(), "-ss", secs(startMs), "-to", secs(endMs), "-i", in,
		"-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-map_metadata", "0", out)
}

// encodeClipArgs cuts [startMs, endMs] frame-accurately as H.264/AAC.
func encodeClipArgs(in, out string, startMs, endMs int64) []string {
	return append(commonArgs(), "-ss", secs(startMs), "-i", in, "-t", secs(endMs-startMs),
		"-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out)
}

// stillArgs grabs one frame at atMs as a JPG.
func stillArgs(in, out string, atMs int64) []string {
	return append(commonArgs(), "-ss", secs(atMs), "-i", in, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", out)
}

// copyExt is the extension of a stream-copied clip of an input with ext.
func copyExt(ext string) string {
	ext = strings.ToLower(ext)
	switch ext {
	case ".ts", ".mts", ".m2ts":
		return ".ts"
	case "":
		return ".mp4"
	}
	return ext
}

// timeLabel formats ms as m:ss (or h:mm:ss) for messages.
func timeLabel(ms int64) string {
	s := ms / 1000
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s%3600/60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}
