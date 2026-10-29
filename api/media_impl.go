package api

// MD1 owns this file (SPEC.md §3.2, §3.4): the /media route and the
// MediaService methods behind the frozen signatures in media.go.

import (
	"bufio"
	"container/list"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

const (
	tokenLRUSize = 512
	opTimeout    = 60 * time.Second
)

// tokenTable is the in-memory token → path LRU. The zero value is ready.
type tokenTable struct {
	mu      sync.Mutex
	byToken map[string]*list.Element // value: *tokenEntry
	byPath  map[string]*list.Element
	order   *list.List // front = most recent
}

type tokenEntry struct{ token, path string }

func (t *tokenTable) tokenFor(path string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.order == nil {
		t.order = list.New()
		t.byToken = map[string]*list.Element{}
		t.byPath = map[string]*list.Element{}
	}
	if el, ok := t.byPath[path]; ok {
		t.order.MoveToFront(el)
		return el.Value.(*tokenEntry).token
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failing is unrecoverable
	}
	e := &tokenEntry{token: hex.EncodeToString(b[:]), path: path}
	el := t.order.PushFront(e)
	t.byToken[e.token] = el
	t.byPath[path] = el
	for t.order.Len() > tokenLRUSize {
		last := t.order.Back()
		old := last.Value.(*tokenEntry)
		t.order.Remove(last)
		delete(t.byToken, old.token)
		delete(t.byPath, old.path)
	}
	return e.token
}

func (t *tokenTable) lookup(token string) (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	el, ok := t.byToken[token]
	if !ok {
		return "", false
	}
	t.order.MoveToFront(el)
	return el.Value.(*tokenEntry).path, true
}

func (s *MediaService) mediaURL(path string) string {
	return MediaPrefix + s.tokens.tokenFor(path) + "/" + url.PathEscape(filepath.Base(path))
}

var mediaTypes = map[string]string{
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
	".webm": "video/webm", ".mkv": "video/x-matroska",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
	".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
}

func contentType(path string) string {
	if t, ok := mediaTypes[strings.ToLower(filepath.Ext(path))]; ok {
		return t
	}
	return "application/octet-stream"
}

// parseRange resolves a Range header against size into [start, end]
// inclusive, capped at MaxMediaResponse. ok=false means 416.
func parseRange(h string, size int64) (start, end int64, ok bool) {
	spec, found := strings.CutPrefix(strings.TrimSpace(h), "bytes=")
	if !found || strings.Contains(spec, ",") || size <= 0 {
		return 0, 0, false
	}
	a, b, found := strings.Cut(strings.TrimSpace(spec), "-")
	if !found {
		return 0, 0, false
	}
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	switch {
	case a == "": // suffix
		n, err := strconv.ParseInt(b, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		start = max(size-n, 0)
		end = size - 1
	default:
		var err error
		if start, err = strconv.ParseInt(a, 10, 64); err != nil || start < 0 || start >= size {
			return 0, 0, false
		}
		end = size - 1
		if b != "" {
			e, err := strconv.ParseInt(b, 10, 64)
			if err != nil || e < start {
				return 0, 0, false
			}
			end = min(e, end)
		}
	}
	end = min(end, start+MaxMediaResponse-1)
	return start, end, true
}

func (m *MediaService) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, MediaPrefix), "/")
	path, ok := m.tokens.lookup(token)
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	size := fi.Size()
	h := w.Header()
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Type", contentType(path))

	status := http.StatusOK
	start, end := int64(0), size-1
	if rh := r.Header.Get("Range"); rh != "" {
		var ok bool
		if start, end, ok = parseRange(rh, size); !ok {
			h.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			http.Error(w, "range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		status = http.StatusPartialContent
	} else if size > MaxMediaResponse {
		end = MaxMediaResponse - 1
		status = http.StatusPartialContent
	}
	n := end - start + 1
	if size == 0 {
		n = 0
	}
	if status == http.StatusPartialContent {
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
	}
	h.Set("Content-Length", strconv.FormatInt(n, 10))
	w.WriteHeader(status)
	if r.Method == http.MethodHead || n == 0 {
		return
	}
	_, _ = io.Copy(w, io.NewSectionReader(f, start, n))
}

// ---- helpers ----

func (s *MediaService) tool(id string) (string, error) {
	if s.Resolve == nil {
		return "", core.ErrDependencyMissing(id, "")
	}
	return s.Resolve(id)
}

func statFile(path string) (os.FileInfo, error) {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return nil, core.Errorf(core.CodeNotFound, "This file doesn't exist any more")
	}
	return fi, nil
}

func (s *MediaService) probe(ctx context.Context, path string) (media.Info, os.FileInfo, error) {
	fi, err := statFile(path)
	if err != nil {
		return media.Info{}, nil, err
	}
	ffprobe, err := s.tool("ffprobe")
	if err != nil {
		return media.Info{}, nil, err
	}
	info, err := media.Probe(ctx, ffprobe, path)
	return info, fi, err
}

func (s *MediaService) cacheDir() string { return media.CacheDir(s.Paths) }

func (s *MediaService) submitJob(ctx context.Context, module string, inputs []string, opts string) ([]core.Job, error) {
	if s.submit != nil {
		return s.submit(ctx, module, inputs, opts)
	}
	if s.Jobs == nil {
		return nil, core.Errorf(core.CodeInternal, "Jobs aren't available")
	}
	return s.Jobs.Submit(ctx, module, inputs, opts)
}

func (s *MediaService) listJobs(ctx context.Context, f core.JobFilter) ([]core.Job, error) {
	if s.list != nil {
		return s.list(ctx, f)
	}
	if s.Jobs == nil {
		return nil, core.Errorf(core.CodeInternal, "Jobs aren't available")
	}
	return s.Jobs.List(ctx, f)
}

// ---- methods ----

func (s *MediaService) open(path string) (MediaSource, error) {
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	info, fi, err := s.probe(ctx, path)
	if err != nil {
		return MediaSource{}, err
	}
	src := MediaSource{Info: info}
	if media.Playable(info, filepath.Ext(path), s.GOOS) {
		src.URL = s.mediaURL(path)
		return src, nil
	}
	audioOnly := info.Video == nil
	pp := media.ProxyPath(s.cacheDir(), path, fi.Size(), fi.ModTime().UnixNano(), audioOnly)
	if pfi, err := os.Stat(pp); err == nil && pfi.Mode().IsRegular() {
		_ = os.Chtimes(pp, time.Now(), time.Now()) // keep in-use previews young for the prune
		src.URL = s.mediaURL(pp)
		src.Proxy = true
		return src, nil
	}
	running, err := s.listJobs(ctx, core.JobFilter{
		ModuleID: media.ProxyModuleID,
		Statuses: []core.JobStatus{core.JobQueued, core.JobRunning},
		Limit:    500,
	})
	if err != nil {
		return src, err
	}
	for _, j := range running {
		if len(j.Inputs) == 1 && j.Inputs[0] == path {
			src.ProxyJobID = j.ID
			return src, nil
		}
	}
	jobs, err := s.submitJob(ctx, media.ProxyModuleID, []string{path}, "{}")
	if err != nil {
		return src, err
	}
	if len(jobs) == 0 {
		return src, core.Errorf(core.CodeInternal, "Couldn't start the preview copy")
	}
	src.ProxyJobID = jobs[0].ID
	return src, nil
}

func (s *MediaService) keyframes(path string) ([]int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*opTimeout)
	defer cancel()
	info, _, err := s.probe(ctx, path)
	if err != nil {
		return nil, err
	}
	ffprobe, err := s.tool("ffprobe")
	if err != nil {
		return nil, err
	}
	kf, err := media.Keyframes(ctx, ffprobe, path)
	if err != nil {
		return nil, err
	}
	out := make([]int64, len(kf))
	for i, v := range kf {
		out[i] = max(v-info.StartMs, 0)
	}
	return out, nil
}

// tempSibling returns a temp file name next to final that keeps its extension.
func tempSibling(final string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	ext := filepath.Ext(final)
	return strings.TrimSuffix(final, ext) + ".part-" + hex.EncodeToString(b[:]) + ext
}

// runFFmpeg runs ffmpeg writing to a temp file, then renames it to final.
// args must end just before the output name.
func (s *MediaService) runFFmpeg(ctx context.Context, final string, args []string) error {
	ffmpeg, err := s.tool("ffmpeg")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return fmt.Errorf("creating cache folder: %w", err)
	}
	tmp := tempSibling(final)
	defer os.Remove(tmp)
	full := append([]string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}, args...)
	full = append(full, tmp)
	res, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: full})
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("ffmpeg: %w", ctx.Err())
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return core.Errorf(core.CodeToolFailed, "Couldn't read frames from this file").WithHint(hint)
	}
	if fi, err := os.Stat(tmp); err != nil || fi.Size() == 0 {
		return core.Errorf(core.CodeToolFailed, "Couldn't read frames from this file")
	}
	if err := os.Rename(tmp, final); err != nil {
		return fmt.Errorf("saving cache file: %w", err)
	}
	return nil
}

func (s *MediaService) filmstrip(path string, count, height int) (string, error) {
	fields := map[string]string{}
	if count < 4 || count > 60 {
		fields["count"] = "Use 4 to 60 frames"
	}
	if height < 40 || height > 160 {
		fields["height"] = "Use a height of 40 to 160 pixels"
	}
	if len(fields) > 0 {
		return "", core.ValidationError("Invalid filmstrip size", fields)
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	info, fi, err := s.probe(ctx, path)
	if err != nil {
		return "", err
	}
	if info.Video == nil {
		return "", core.ValidationError("This file has no video", nil)
	}
	key := media.CacheKey(path, fi.Size(), fi.ModTime().UnixNano())
	final := filepath.Join(s.cacheDir(), "strip", fmt.Sprintf("%s-%d-%d.jpg", key, count, height))
	if cached(final) {
		return s.mediaURL(final), nil
	}
	dur := float64(info.DurationMs) / 1000
	if dur <= 0 {
		dur = 1
	}
	fps := strconv.FormatFloat(float64(count)/dur, 'f', 6, 64)
	err = s.runFFmpeg(ctx, final, []string{"-i", path,
		"-vf", fmt.Sprintf("fps=%s,scale=-2:%d,tile=%dx1", fps, height, count),
		"-frames:v", "1", "-q:v", "4", "-update", "1"})
	if err != nil {
		return "", err
	}
	media.PruneCache(s.cacheDir(), media.CacheLimitBytes)
	return s.mediaURL(final), nil
}

func cached(p string) bool {
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() == 0 {
		return false
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now)
	return true
}

func (s *MediaService) frame(path string, ms int64, maxDim int) (string, error) {
	fields := map[string]string{}
	if ms < 0 {
		fields["ms"] = "Time can't be negative"
	}
	if maxDim < 64 || maxDim > 4096 {
		fields["maxDim"] = "Use a size of 64 to 4096 pixels"
	}
	if len(fields) > 0 {
		return "", core.ValidationError("Invalid frame request", fields)
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	info, fi, err := s.probe(ctx, path)
	if err != nil {
		return "", err
	}
	if info.Video == nil {
		return "", core.ValidationError("This file has no video", nil)
	}
	key := media.CacheKey(path, fi.Size(), fi.ModTime().UnixNano())
	final := filepath.Join(s.cacheDir(), "frame", fmt.Sprintf("%s-%d-%d.jpg", key, ms, maxDim))
	if cached(final) {
		return s.mediaURL(final), nil
	}
	sec := strconv.FormatFloat(float64(ms+info.StartMs)/1000, 'f', 3, 64)
	err = s.runFFmpeg(ctx, final, []string{"-ss", sec, "-i", path, "-frames:v", "1",
		"-vf", fmt.Sprintf("scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease", maxDim, maxDim),
		"-q:v", "3", "-update", "1"})
	if err != nil {
		return "", err
	}
	media.PruneCache(s.cacheDir(), media.CacheLimitBytes)
	return s.mediaURL(final), nil
}

func (s *MediaService) waveform(path string, buckets int) ([]float32, error) {
	if buckets < 100 || buckets > 4000 {
		return nil, core.ValidationError("Invalid waveform size",
			map[string]string{"buckets": "Use 100 to 4000 buckets"})
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	info, fi, err := s.probe(ctx, path)
	if err != nil {
		return nil, err
	}
	if len(info.Audio) == 0 {
		return nil, core.ValidationError("This file has no audio", nil)
	}
	key := media.CacheKey(path, fi.Size(), fi.ModTime().UnixNano())
	final := filepath.Join(s.cacheDir(), "wave", fmt.Sprintf("%s-%d.bin", key, buckets))
	if peaks, ok := readWaveCache(final, buckets); ok {
		return peaks, nil
	}
	ffmpeg, err := s.tool("ffmpeg")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return nil, fmt.Errorf("creating cache folder: %w", err)
	}
	// proc delivers stdout line by line, which would mangle binary PCM, so
	// FFmpeg writes the raw samples to a temp file that Go streams.
	pcm := tempSibling(filepath.Join(filepath.Dir(final), key+".pcm"))
	defer os.Remove(pcm)
	res, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", path,
		"-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", pcm}})
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("ffmpeg: %w", ctx.Err())
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return nil, core.Errorf(core.CodeToolFailed, "Couldn't read this file's audio").WithHint(hint)
	}
	peaks, err := computePeaks(pcm, buckets)
	if err != nil {
		return nil, err
	}
	writeWaveCache(final, peaks)
	media.PruneCache(s.cacheDir(), media.CacheLimitBytes)
	return peaks, nil
}

// computePeaks reads s16le mono samples and returns per-bucket peak |s|/32768.
func computePeaks(pcmPath string, buckets int) ([]float32, error) {
	f, err := os.Open(pcmPath)
	if err != nil {
		return nil, fmt.Errorf("reading audio: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	total := fi.Size() / 2
	peaks := make([]float32, buckets)
	if total == 0 {
		return peaks, nil
	}
	r := bufio.NewReaderSize(f, 1<<16)
	var buf [2]byte
	for i := int64(0); i < total; i++ {
		if _, err := io.ReadFull(r, buf[:]); err != nil {
			break
		}
		v := math.Abs(float64(int16(binary.LittleEndian.Uint16(buf[:])))) / 32768
		b := int(i * int64(buckets) / total)
		if float32(v) > peaks[b] {
			peaks[b] = float32(v)
		}
	}
	return peaks, nil
}

func readWaveCache(p string, buckets int) ([]float32, bool) {
	data, err := os.ReadFile(p)
	if err != nil || len(data) != buckets*4 {
		return nil, false
	}
	out := make([]float32, buckets)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(data[i*4:]))
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now)
	return out, true
}

func writeWaveCache(p string, peaks []float32) {
	data := make([]byte, len(peaks)*4)
	for i, v := range peaks {
		binary.LittleEndian.PutUint32(data[i*4:], math.Float32bits(v))
	}
	tmp := tempSibling(p)
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
	}
}

func (s *MediaService) urlFor(path string) (string, error) {
	if _, err := statFile(path); err != nil {
		return "", err
	}
	return s.mediaURL(path), nil
}
