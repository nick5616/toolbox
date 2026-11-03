package editstudio

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

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

// H.264 NAL unit types the index cares about.
const (
	nalIDR = 5
	nalSPS = 7
	nalAUD = 9
)

// indexChunkSize is how much of a stream is read at a time (a var for tests).
var indexChunkSize = 1 << 20

// BuildIndex splits an Annex-B stream (one AUD per access unit) into frames.
func BuildIndex(data []byte, width, height, fps int) (StreamIndex, error) {
	return scanIndex(bytes.NewReader(data), width, height, fps)
}

// WriteIndex reads a stream file and writes its index next to it.
func WriteIndex(stream string, width, height, fps int) (StreamIndex, error) {
	return writeIndexAs(stream, IndexPath(stream), width, height, fps)
}

// writeIndexAs indexes the stream file at src and writes the index to path.
func writeIndexAs(stream, path string, width, height, fps int) (StreamIndex, error) {
	f, err := os.Open(stream)
	if err != nil {
		return StreamIndex{}, fmt.Errorf("opening %s: %w", filepath.Base(stream), err)
	}
	idx, err := scanIndex(f, width, height, fps)
	f.Close()
	if err != nil {
		return StreamIndex{}, err
	}
	b, err := json.Marshal(idx)
	if err != nil {
		return StreamIndex{}, fmt.Errorf("encoding the index: %w", err)
	}
	tmp := path + ".part"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return StreamIndex{}, fmt.Errorf("writing the index: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return StreamIndex{}, fmt.Errorf("saving the index: %w", err)
	}
	return idx, nil
}

// ReadIndex loads a stream's index file.
func ReadIndex(stream string) (StreamIndex, error) {
	b, err := os.ReadFile(IndexPath(stream))
	if err != nil {
		return StreamIndex{}, err
	}
	var idx StreamIndex
	if err := json.Unmarshal(b, &idx); err != nil {
		return StreamIndex{}, fmt.Errorf("reading the index of %s: %w", filepath.Base(stream), err)
	}
	if idx.Version != 1 || len(idx.Offsets) != idx.Frames+1 {
		return StreamIndex{}, errors.New("index is not valid")
	}
	return idx, nil
}

// auScan accumulates access units while NAL units stream past.
type auScan struct {
	offsets []int64
	keys    []int
	codec   string
	curKey  bool
	curVCL  bool
	lastVCL bool // whether the last closed access unit had a picture
	started bool
	err     error
}

// nal handles one NAL unit: start is the stream offset of its start code
// (including a leading zero byte), hdr the bytes from the NAL header on.
func (s *auScan) nal(start int64, hdr []byte) {
	if s.err != nil || len(hdr) == 0 {
		return
	}
	typ := hdr[0] & 0x1f
	if typ == nalAUD {
		s.closeAU()
		if !s.started && start != 0 {
			s.err = errors.New("the stream doesn't start with an access unit delimiter")
			return
		}
		s.started = true
		s.offsets = append(s.offsets, start)
		return
	}
	if !s.started {
		s.err = errors.New("the stream doesn't start with an access unit delimiter")
		return
	}
	switch {
	case typ == nalSPS:
		if s.codec == "" && len(hdr) >= 4 {
			s.codec = fmt.Sprintf("avc1.%02x%02x%02x", hdr[1], hdr[2], hdr[3])
		}
	case typ >= 1 && typ <= nalIDR:
		s.curVCL = true
		if typ == nalIDR {
			s.curKey = true
		}
	}
}

// closeAU ends the current access unit (recording it as a key when it has an IDR).
func (s *auScan) closeAU() {
	if !s.started {
		return
	}
	if s.curKey {
		s.keys = append(s.keys, len(s.offsets)-1)
	}
	s.lastVCL = s.curVCL
	s.curKey, s.curVCL = false, false
}

// scanIndex reads an Annex-B stream in chunks and builds its index.
func scanIndex(r io.Reader, width, height, fps int) (StreamIndex, error) {
	var s auScan
	buf := make([]byte, 0, indexChunkSize+16)
	tmp := make([]byte, indexChunkSize)
	var base int64 // stream offset of buf[0]
	from := 0      // next buf position to search
	eof := false
	for !eof {
		n, err := io.ReadFull(r, tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
				return StreamIndex{}, fmt.Errorf("reading the stream: %w", err)
			}
			eof = true
		}
		i := from
		for {
			j := bytes.IndexByte(buf[i:], 1)
			if j < 0 {
				i = len(buf)
				break
			}
			p := i + j
			if !eof && p+4 >= len(buf) { // the NAL header (and SPS bytes) may continue in the next chunk
				i = p
				break
			}
			i = p + 1
			if p < 2 || buf[p-1] != 0 || buf[p-2] != 0 {
				continue
			}
			start := p - 2
			if p >= 3 && buf[p-3] == 0 {
				start = p - 3
			}
			end := min(p+5, len(buf))
			s.nal(base+int64(start), buf[p+1:end])
			if s.err != nil {
				return StreamIndex{}, s.err
			}
		}
		keep := max(0, i-3)
		if keep > 0 {
			buf = append(buf[:0], buf[keep:]...)
			base += int64(keep)
		}
		from = i - keep
	}
	total := base + int64(len(buf))
	s.closeAU()
	// An access unit with no picture in it is a truncated tail: drop it.
	if s.started && !s.lastVCL && len(s.offsets) > 0 {
		last := len(s.offsets) - 1
		total = s.offsets[last]
		s.offsets = s.offsets[:last]
		if n := len(s.keys); n > 0 && s.keys[n-1] == last {
			s.keys = s.keys[:n-1]
		}
	}
	return s.finish(width, height, fps, total)
}

func (s *auScan) finish(width, height, fps int, total int64) (StreamIndex, error) {
	if len(s.offsets) == 0 {
		return StreamIndex{}, errors.New("no video frames in the stream")
	}
	if s.codec == "" {
		return StreamIndex{}, errors.New("the stream has no SPS")
	}
	idx := StreamIndex{
		Version: 1, Codec: s.codec, Width: width, Height: height, FPS: fps,
		Frames: len(s.offsets), Offsets: append(s.offsets, total), Keys: s.keys, Bytes: total,
	}
	if idx.Keys == nil {
		idx.Keys = []int{}
	}
	return idx, nil
}

// indexError wraps a parser failure for users.
func indexError(err error) error {
	return core.Errorf(core.CodeToolFailed, "FFmpeg wrote a video the editor can't use").WithHint(err.Error()).WithCause(err)
}
