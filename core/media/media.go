// Package media probes audio/video files with ffprobe and holds the helpers
// shared by the FFmpeg-based tools: progress parsing, the ASS subtitle
// writer, the font list and the webview playability table (SPEC.md §3.3).
// It imports only core and core/proc.
package media

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

// Info is the probed shape of a media file (times in ms).
type Info struct {
	DurationMs int64             `json:"durationMs"`
	StartMs    int64             `json:"startMs"`   // container start_time (≠ 0 for some TS/MKV files)
	Container  string            `json:"container"` // ffprobe format_name, first entry
	SizeBytes  int64             `json:"sizeBytes"`
	BitRate    int64             `json:"bitRate"` // bit/s, 0 = unknown
	Video      *VideoStream      `json:"video"`   // nil = no video (cover art is not video)
	Audio      []AudioStream     `json:"audio"`
	Subtitles  []SubtitleStream  `json:"subtitles"`
	HasCover   bool              `json:"hasCover"` // attached_pic stream
	Tags       map[string]string `json:"tags"`     // lowercased keys: title, artist, album, …
}

// VideoStream is the first real video stream.
type VideoStream struct {
	Index    int     `json:"index"`
	Codec    string  `json:"codec"`
	Width    int     `json:"width"`  // display size: rotation and SAR applied
	Height   int     `json:"height"` //
	FPS      float64 `json:"fps"`    // avg_frame_rate; 0 = unknown
	Rotation int     `json:"rotation"`
	PixFmt   string  `json:"pixFmt"`
}

// AudioStream is one audio stream.
type AudioStream struct {
	Index      int    `json:"index"`
	Codec      string `json:"codec"`
	Channels   int    `json:"channels"`
	SampleRate int    `json:"sampleRate"`
	Language   string `json:"language"` // ISO 639-2 tag or ""
}

// SubtitleStream is one subtitle stream.
type SubtitleStream struct {
	Index    int    `json:"index"`
	Codec    string `json:"codec"`
	Language string `json:"language"`
	Title    string `json:"title"`
	Text     bool   `json:"text"` // subrip/ass/webvtt/mov_text: extractable as text
}

// probeTimeout bounds one ffprobe run.
const probeTimeout = 30 * time.Second

type cacheKey struct {
	path  string
	size  int64
	mtime int64
}

var (
	cacheMu    sync.Mutex
	cache      = map[cacheKey]Info{}
	cacheOrder []cacheKey
)

const cacheMax = 256

// Probe runs ffprobe on path. Results are cached by (path, size, mtime).
func Probe(ctx context.Context, ffprobe, path string) (Info, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return Info{}, core.Errorf(core.CodeNotFound, "This file doesn't exist any more").WithHint(path)
	}
	key := cacheKey{path, fi.Size(), fi.ModTime().UnixNano()}
	cacheMu.Lock()
	if info, ok := cache[key]; ok {
		cacheMu.Unlock()
		return info, nil
	}
	cacheMu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	var out strings.Builder
	res, err := proc.Run(ctx, proc.Spec{
		Path:     ffprobe,
		Args:     []string{"-v", "error", "-print_format", "json", "-show_format", "-show_streams", path},
		OnStdout: func(l string) { out.WriteString(l); out.WriteByte('\n') },
	})
	if err != nil {
		if ctx.Err() != nil && ctx.Err() != context.DeadlineExceeded {
			return Info{}, ctx.Err()
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return Info{}, core.Errorf(core.CodeToolFailed, "Couldn't read this file as audio or video").WithHint(hint)
	}
	info, err := parseProbe([]byte(out.String()))
	if err != nil {
		return Info{}, core.Errorf(core.CodeToolFailed, "Couldn't read this file as audio or video").WithHint(err.Error())
	}
	if info.SizeBytes == 0 {
		info.SizeBytes = fi.Size()
	}
	cacheMu.Lock()
	if _, ok := cache[key]; !ok {
		cache[key] = info
		cacheOrder = append(cacheOrder, key)
		if len(cacheOrder) > cacheMax {
			delete(cache, cacheOrder[0])
			cacheOrder = cacheOrder[1:]
		}
	}
	cacheMu.Unlock()
	return info, nil
}

// probeJSON mirrors the parts of ffprobe's JSON we read.
type probeJSON struct {
	Streams []struct {
		Index        int               `json:"index"`
		CodecType    string            `json:"codec_type"`
		CodecName    string            `json:"codec_name"`
		Width        int               `json:"width"`
		Height       int               `json:"height"`
		SampleAspect string            `json:"sample_aspect_ratio"`
		AvgFrameRate string            `json:"avg_frame_rate"`
		RFrameRate   string            `json:"r_frame_rate"`
		PixFmt       string            `json:"pix_fmt"`
		Channels     int               `json:"channels"`
		SampleRate   string            `json:"sample_rate"`
		Disposition  map[string]int    `json:"disposition"`
		Tags         map[string]string `json:"tags"`
		SideDataList []map[string]any  `json:"side_data_list"`
	} `json:"streams"`
	Format struct {
		FormatName string            `json:"format_name"`
		StartTime  string            `json:"start_time"`
		Duration   string            `json:"duration"`
		Size       string            `json:"size"`
		BitRate    string            `json:"bit_rate"`
		Tags       map[string]string `json:"tags"`
	} `json:"format"`
}

// textSubtitleCodecs can be extracted as text.
var textSubtitleCodecs = map[string]bool{"subrip": true, "srt": true, "ass": true, "ssa": true, "webvtt": true, "mov_text": true, "text": true}

func parseProbe(data []byte) (Info, error) {
	var p probeJSON
	if err := json.Unmarshal(data, &p); err != nil {
		return Info{}, fmt.Errorf("parsing ffprobe output: %w", err)
	}
	info := Info{
		Container:  strings.Split(p.Format.FormatName, ",")[0],
		DurationMs: secToMs(p.Format.Duration),
		StartMs:    secToMs(p.Format.StartTime),
		SizeBytes:  parseInt(p.Format.Size),
		BitRate:    parseInt(p.Format.BitRate),
		Audio:      []AudioStream{},
		Subtitles:  []SubtitleStream{},
		Tags:       lowerKeys(p.Format.Tags),
	}
	for _, s := range p.Streams {
		tags := lowerKeys(s.Tags)
		switch s.CodecType {
		case "video":
			if s.Disposition["attached_pic"] == 1 {
				info.HasCover = true
				continue
			}
			if info.Video != nil {
				continue
			}
			rot := rotationOf(s.SideDataList, tags)
			w, h := s.Width, s.Height
			if num, den, ok := ratio(s.SampleAspect); ok && num > 0 && den > 0 && num != den {
				w = even(int(math.Round(float64(w) * float64(num) / float64(den))))
			}
			if rot == 90 || rot == 270 {
				w, h = h, w
			}
			fps := frameRate(s.AvgFrameRate)
			if fps == 0 {
				fps = frameRate(s.RFrameRate)
			}
			info.Video = &VideoStream{Index: s.Index, Codec: s.CodecName, Width: w, Height: h, FPS: fps, Rotation: rot, PixFmt: s.PixFmt}
		case "audio":
			info.Audio = append(info.Audio, AudioStream{
				Index: s.Index, Codec: s.CodecName, Channels: s.Channels,
				SampleRate: int(parseInt(s.SampleRate)), Language: tags["language"],
			})
		case "subtitle":
			info.Subtitles = append(info.Subtitles, SubtitleStream{
				Index: s.Index, Codec: s.CodecName, Language: tags["language"], Title: tags["title"],
				Text: textSubtitleCodecs[s.CodecName],
			})
		}
	}
	return info, nil
}

// rotationOf reads the display-matrix rotation (side data, or the legacy
// "rotate" tag), normalised to 0/90/180/270.
func rotationOf(side []map[string]any, tags map[string]string) int {
	r := 0.0
	found := false
	for _, sd := range side {
		if v, ok := sd["rotation"].(float64); ok {
			r, found = v, true
			break
		}
	}
	if !found {
		if v, err := strconv.ParseFloat(tags["rotate"], 64); err == nil {
			r = v
		}
	}
	n := int(math.Round(r/90)) * 90
	return ((n % 360) + 360) % 360
}

func secToMs(s string) int64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	return int64(math.Round(v * 1000))
}

func parseInt(s string) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}

func ratio(s string) (int, int, bool) {
	a, b, ok := strings.Cut(s, ":")
	if !ok {
		a, b, ok = strings.Cut(s, "/")
	}
	if !ok {
		return 0, 0, false
	}
	n, err1 := strconv.Atoi(a)
	d, err2 := strconv.Atoi(b)
	return n, d, err1 == nil && err2 == nil
}

func frameRate(s string) float64 {
	n, d, ok := ratio(s)
	if !ok || n <= 0 || d <= 0 {
		return 0
	}
	return math.Round(float64(n)/float64(d)*1000) / 1000
}

func even(v int) int { return v &^ 1 }

func lowerKeys(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[strings.ToLower(k)] = v
	}
	return out
}

// Keyframes lists the presentation times of the video's keyframes (ms,
// ascending). Subtract Info.StartMs for timeline times.
func Keyframes(ctx context.Context, ffprobe, path string) ([]int64, error) {
	var times []int64
	res, err := proc.Run(ctx, proc.Spec{
		Path: ffprobe,
		Args: []string{"-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
			"-show_entries", "frame=pts_time", "-of", "csv=p=0", path},
		OnStdout: func(l string) {
			if v, err := strconv.ParseFloat(strings.Trim(l, ", "), 64); err == nil && v >= 0 {
				times = append(times, int64(math.Round(v*1000)))
			}
		},
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return nil, core.Errorf(core.CodeToolFailed, "Couldn't read the video's keyframes").WithHint(hint)
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	if times == nil {
		times = []int64{}
	}
	return times, nil
}
