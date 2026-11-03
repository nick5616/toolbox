package editstudio

import "strings"

// Annex-B frame index (SPEC.md §7.2). WP-ES4.

// StreamIndex is the content of <stream>.idx.json.
type StreamIndex struct {
	Version int     `json:"version"` // 1
	Codec   string  `json:"codec"`   // "avc1.PPCCLL" from the SPS
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	FPS     int     `json:"fps"`
	Frames  int     `json:"frames"`
	Offsets []int64 `json:"offsets"` // frames+1 entries; the last is the file size
	Keys    []int   `json:"keys"`    // IDR frame numbers
	Bytes   int64   `json:"bytes"`
}

// IndexPath is the index file of a stream ("x.h264" → "x.idx.json").
func IndexPath(stream string) string {
	return strings.TrimSuffix(stream, ".h264") + ".idx.json"
}

// BuildIndex splits an Annex-B stream (one AUD per access unit) into frames.
func BuildIndex(data []byte, width, height, fps int) (StreamIndex, error) {
	return StreamIndex{}, notBuilt("Stream index")
}

// WriteIndex reads a stream file and writes its index next to it.
func WriteIndex(stream string, width, height, fps int) (StreamIndex, error) {
	return StreamIndex{}, notBuilt("Stream index")
}
