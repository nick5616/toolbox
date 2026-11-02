// Package heic turns HEIC/HEIF photos into PNGs that the rest of Toolbox can
// read (Go has no HEIC decoder). FFmpeg does it first: iPhone photos are a
// grid of 512 px HEVC tiles, which FFmpeg 8 demuxes as a "Tile Grid" stream
// group but doesn't stitch, so the tiles are stitched with xstack and cropped
// here, and the photo's rotation (irot, exported as a display matrix) is
// applied. The AI engine's image.convert (libheif) is the fallback. Results
// are cached by path + size + mtime.
package heic

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

// cacheVersion changes when conversions change (v2: rotation read from
// FFmpeg's stream dump, which ffprobe 8 leaves out for tile grids).
const cacheVersion = "v2"

// Decoder converts HEIC files to cached PNGs.
type Decoder struct {
	// Resolve finds ffmpeg/ffprobe (and the engine dep); nil = no FFmpeg path.
	Resolve func(depID string) (string, error)
	// Engine is the AI engine (image.convert); nil = no fallback.
	Engine sidecar.Caller
	// CacheDir holds the PNGs (<support>/cache/heic).
	CacheDir string

	mu       sync.Mutex
	inflight map[string]*call
}

type call struct {
	done chan struct{}
	path string
	err  error
}

// Is reports whether path has a HEIC/HEIF extension.
func Is(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".heic" || ext == ".heif"
}

// ToPNG returns a PNG of the (upright) photo at path, converting it on first
// use. Concurrent calls for the same file share one conversion.
func (d *Decoder) ToPNG(ctx context.Context, path string) (string, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path)).WithCause(err)
	}
	sum := sha1.Sum([]byte(fmt.Sprintf("%s|%s|%d|%d", cacheVersion, path, fi.Size(), fi.ModTime().UnixNano())))
	key := hex.EncodeToString(sum[:])
	out := filepath.Join(d.CacheDir, key+".png")
	if st, err := os.Stat(out); err == nil && st.Size() > 0 {
		return out, nil
	}

	d.mu.Lock()
	if d.inflight == nil {
		d.inflight = map[string]*call{}
	}
	if c, ok := d.inflight[key]; ok {
		d.mu.Unlock()
		select {
		case <-c.done:
			return c.path, c.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	c := &call{done: make(chan struct{})}
	d.inflight[key] = c
	d.mu.Unlock()

	c.path, c.err = d.convert(ctx, path, out)
	close(c.done)
	d.mu.Lock()
	delete(d.inflight, key)
	d.mu.Unlock()
	return c.path, c.err
}

func (d *Decoder) convert(ctx context.Context, src, out string) (string, error) {
	if err := os.MkdirAll(d.CacheDir, 0o755); err != nil {
		return "", fmt.Errorf("create HEIC cache: %w", err)
	}
	tmp := out + ".part.png"
	defer os.Remove(tmp)
	ffErr := d.viaFFmpeg(ctx, src, tmp)
	if ffErr != nil {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if d.Engine == nil || !d.engineInstalled() {
			return "", unavailable(ffErr)
		}
		if _, err := d.Engine.Call(ctx, "image.convert", map[string]any{"input": src, "output": tmp}, nil); err != nil {
			return "", core.Errorf(core.CodeToolFailed, "Couldn't read this HEIC photo").
				WithHint("It may be damaged, or use a variant Toolbox can't decode").WithCause(fmt.Errorf("ffmpeg: %v; engine: %w", ffErr, err))
		}
	}
	if err := os.Rename(tmp, out); err != nil {
		return "", fmt.Errorf("store HEIC conversion: %w", err)
	}
	return out, nil
}

func (d *Decoder) engineInstalled() bool {
	if d.Resolve == nil {
		return true
	}
	_, err := d.Resolve(sidecar.DepID)
	return err == nil
}

func unavailable(cause error) error {
	return core.Errorf(core.CodeDependencyMissing, "Couldn't read this HEIC photo").
		WithHint("Install the Media pack (FFmpeg) or the Image pack in Settings → Tool packs").WithCause(cause)
}

// probe is the part of ffprobe's JSON this package reads.
type probe struct {
	Streams []struct {
		Index        int    `json:"index"`
		CodecType    string `json:"codec_type"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		PixFmt       string `json:"pix_fmt"`
		SideDataList []struct {
			Rotation *float64 `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"streams"`
	StreamGroups []struct {
		Type       string `json:"type"`
		Components []struct {
			HOffset       int `json:"horizontal_offset"`
			VOffset       int `json:"vertical_offset"`
			Width         int `json:"width"`
			Height        int `json:"height"`
			Subcomponents []struct {
				StreamIndex int `json:"stream_index"`
				TileX       int `json:"tile_horizontal_offset"`
				TileY       int `json:"tile_vertical_offset"`
			} `json:"subcomponents"`
			SideDataList []struct {
				Rotation *float64 `json:"rotation"`
			} `json:"side_data_list"`
		} `json:"components"`
		SideDataList []struct {
			Rotation *float64 `json:"rotation"`
		} `json:"side_data_list"`
	} `json:"stream_groups"`
}

func (d *Decoder) viaFFmpeg(ctx context.Context, src, out string) error {
	if d.Resolve == nil {
		return fmt.Errorf("no ffmpeg resolver")
	}
	ffprobe, err := d.Resolve("ffprobe")
	if err != nil {
		return err
	}
	ffmpeg, err := d.Resolve("ffmpeg")
	if err != nil {
		return err
	}
	var buf strings.Builder
	pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := proc.Run(pctx, proc.Spec{Path: ffprobe,
		Args:     []string{"-v", "error", "-show_streams", "-show_stream_groups", "-of", "json", src},
		OnStdout: func(l string) { buf.WriteString(l); buf.WriteByte('\n') }})
	if err != nil {
		return fmt.Errorf("ffprobe: %w", err)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("ffprobe exited %d: %s", res.ExitCode, strings.Join(res.StderrTail, " "))
	}
	var p probe
	if err := json.Unmarshal([]byte(buf.String()), &p); err != nil {
		return fmt.Errorf("ffprobe output: %w", err)
	}
	// ffprobe 8 prints empty side data for tile-grid groups, so the rotation
	// (irot) is read from FFmpeg's own stream dump.
	var dump strings.Builder
	dctx, cancel3 := context.WithTimeout(ctx, 30*time.Second)
	defer cancel3()
	_, _ = proc.Run(dctx, proc.Spec{Path: ffmpeg, Args: []string{"-hide_banner", "-i", src},
		OnStderr: func(l string) { dump.WriteString(l); dump.WriteByte('\n') }})
	args, err := buildArgs(p, src, out, dumpRotation(dump.String()))
	if err != nil {
		return err
	}
	rctx, cancel2 := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel2()
	res, err = proc.Run(rctx, proc.Spec{Path: ffmpeg, Args: args})
	if err != nil {
		return fmt.Errorf("ffmpeg: %w", err)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("ffmpeg exited %d: %s", res.ExitCode, strings.Join(res.StderrTail, " "))
	}
	if st, err := os.Stat(out); err != nil || st.Size() == 0 {
		return fmt.Errorf("ffmpeg wrote nothing")
	}
	return nil
}

// buildArgs picks the photo (the tile grid if there is one, else the largest
// video stream, which skips thumbnails, depth and gain maps) and returns the
// FFmpeg arguments that write it upright to out.
func buildArgs(p probe, src, out string, dumped float64) ([]string, error) {
	// Rotation is applied here, once: FFmpeg's own autorotate is off.
	base := []string{"-hide_banner", "-loglevel", "error", "-y", "-noautorotate", "-i", src}
	tail := []string{"-frames:v", "1", "-update", "1", "-pix_fmt", "rgb24", out}
	for _, g := range p.StreamGroups {
		if g.Type != "Tile Grid" || len(g.Components) == 0 {
			continue
		}
		c := g.Components[0]
		if len(c.Subcomponents) == 0 || c.Width <= 0 || c.Height <= 0 {
			continue
		}
		var in, layout []string
		for _, s := range c.Subcomponents {
			in = append(in, fmt.Sprintf("[0:%d]", s.StreamIndex))
			layout = append(layout, fmt.Sprintf("%d_%d", s.TileX, s.TileY))
		}
		rot := rotation(g.SideDataList)
		if rot == 0 {
			rot = rotation(c.SideDataList)
		}
		if rot == 0 { // some files put the display matrix on the tiles
			for _, st := range p.Streams {
				if st.Index == c.Subcomponents[0].StreamIndex {
					rot = rotation(st.SideDataList)
				}
			}
		}
		if rot == 0 {
			rot = dumped
		}
		var graph string
		if len(in) == 1 {
			graph = in[0] + "null"
		} else {
			graph = fmt.Sprintf("%sxstack=inputs=%d:layout=%s:fill=black", strings.Join(in, ""), len(in), strings.Join(layout, "|"))
		}
		graph += fmt.Sprintf(",crop=%d:%d:%d:%d", c.Width, c.Height, c.HOffset, c.VOffset)
		if f := rotateFilter(rot); f != "" {
			graph += "," + f
		}
		graph += "[o]"
		return append(append(base, "-filter_complex", graph, "-map", "[o]"), tail...), nil
	}
	best, area := -1, 0
	var rot float64
	for _, s := range p.Streams {
		if s.CodecType != "video" || strings.HasPrefix(s.PixFmt, "gray") {
			continue
		}
		if a := s.Width * s.Height; a > area {
			best, area = s.Index, a
			rot = rotation(s.SideDataList)
		}
	}
	if best < 0 {
		return nil, fmt.Errorf("no image stream")
	}
	if rot == 0 {
		rot = dumped
	}
	args := append(base, "-map", fmt.Sprintf("0:%d", best))
	if f := rotateFilter(rot); f != "" {
		args = append(args, "-vf", f)
	}
	return append(args, tail...), nil
}

func rotation(list []struct {
	Rotation *float64 `json:"rotation"`
}) float64 {
	for _, sd := range list {
		if sd.Rotation != nil {
			return *sd.Rotation
		}
	}
	return 0
}

// rotateFilter turns FFmpeg's display-matrix rotation (degrees,
// counter-clockwise; −90 = turn clockwise to display) into a filter.
func rotateFilter(deg float64) string {
	r := int(math.Round(deg)) % 360
	if r < 0 {
		r += 360
	}
	switch r {
	case 90:
		return "transpose=cclock"
	case 180:
		return "hflip,vflip"
	case 270:
		return "transpose=clock"
	}
	return ""
}

// Available reports whether a conversion can be attempted: FFmpeg and
// ffprobe resolve, or the AI engine is installed.
func (d *Decoder) Available() bool {
	if d.Resolve != nil {
		_, e1 := d.Resolve("ffmpeg")
		_, e2 := d.Resolve("ffprobe")
		if e1 == nil && e2 == nil {
			return true
		}
	}
	return d.Engine != nil && d.engineInstalled()
}

// Prune deletes cached conversions unused for 30 days, then the oldest until
// the cache is under 2 GB (called at start).
func (d *Decoder) Prune() {
	entries, err := os.ReadDir(d.CacheDir)
	if err != nil {
		return
	}
	type file struct {
		path string
		size int64
		mod  time.Time
	}
	var files []file
	var total int64
	now := time.Now()
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		p := filepath.Join(d.CacheDir, e.Name())
		if now.Sub(info.ModTime()) > 30*24*time.Hour {
			_ = os.Remove(p)
			continue
		}
		files = append(files, file{p, info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		if total <= 2<<30 {
			break
		}
		if os.Remove(f.path) == nil {
			total -= f.size
		}
	}
}

var dumpRotRe = regexp.MustCompile(`displaymatrix: rotation of (-?[0-9]+(?:\.[0-9]+)?) degrees`)

// dumpRotation returns the first display-matrix rotation in FFmpeg's stream
// dump (the image's, listed first), or 0.
func dumpRotation(dump string) float64 {
	m := dumpRotRe.FindStringSubmatch(dump)
	if m == nil {
		return 0
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0
	}
	return v
}
