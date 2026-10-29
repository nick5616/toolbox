package media

// MD1 owns this file (SPEC.md §3.4): the preview-copy job and the cache
// helpers shared with the MediaService in api.

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

// CacheKey is the hex sha1 of path|size|mtimeNs: the identity of one
// version of a file in every cache.
func CacheKey(path string, size, mtimeNs int64) string {
	h := sha1.Sum([]byte(path + "|" + strconv.FormatInt(size, 10) + "|" + strconv.FormatInt(mtimeNs, 10)))
	return hex.EncodeToString(h[:])
}

func proxyPath(cacheDir, path string, size, mtimeNs int64, audioOnly bool) string {
	ext := ".mp4"
	if audioOnly {
		ext = ".m4a"
	}
	return filepath.Join(cacheDir, "proxy", CacheKey(path, size, mtimeNs)+ext)
}

// pruneCache deletes the oldest files (by mtime) under cacheDir until the
// total size is under limit.
func pruneCache(cacheDir string, limit int64) {
	type entry struct {
		path string
		size int64
		mod  int64
	}
	var files []entry
	var total int64
	err := filepath.WalkDir(cacheDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				slog.Warn("cache prune: walk", "err", err)
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		files = append(files, entry{p, fi.Size(), fi.ModTime().UnixNano()})
		total += fi.Size()
		return nil
	})
	if err != nil {
		slog.Warn("cache prune: walk", "err", err)
	}
	if total < limit {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod < files[j].mod })
	for _, f := range files {
		if total < limit {
			break
		}
		if err := os.Remove(f.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("cache prune: remove", "err", err)
			continue
		}
		total -= f.size
	}
}

func (m *ProxyModule) run(ctx context.Context, job *core.JobContext) error {
	if len(job.Inputs) != 1 {
		return core.ValidationError("A preview copy takes one file", nil)
	}
	src := job.Inputs[0]
	fi, err := os.Stat(src)
	if err != nil || fi.IsDir() {
		return core.Errorf(core.CodeNotFound, "This file doesn't exist any more")
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	info, err := Probe(ctx, ffprobe, src)
	if err != nil {
		return err
	}
	audioOnly := info.Video == nil
	if audioOnly && len(info.Audio) == 0 {
		return core.ValidationError("This file has no audio or video to preview", nil)
	}
	job.SetTitle("Preparing preview — " + filepath.Base(src))

	final := proxyPath(m.cacheDir, src, fi.Size(), fi.ModTime().UnixNano(), audioOnly)
	if _, err := os.Stat(final); err == nil {
		now := time.Now()
		_ = os.Chtimes(final, now, now)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return fmt.Errorf("creating preview folder: %w", err)
	}
	ext := filepath.Ext(final)
	part := strings.TrimSuffix(final, ext) + ".part-" + job.ID + ext
	defer os.Remove(part) // no-op after a successful rename

	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src}
	if audioOnly {
		args = append(args, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k")
	} else {
		args = append(args, "-map", "0:v:0?", "-map", "0:a:0?",
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
			"-vf", "scale=-2:'min(720,ih)'", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-b:a", "128k")
	}
	args = append(args, "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", part)

	tr := &ProgressTracker{Duration: float64(info.DurationMs) / 1000, Label: "Preparing preview"}
	job.Progress(0, "Preparing preview")
	res, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: args,
		OnStdout: func(l string) {
			if pct, msg, ok := tr.Apply(l); ok {
				job.Progress(pct, msg)
			}
		},
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return core.Errorf(core.CodeToolFailed, "Couldn't make a preview copy of this file").WithHint(hint)
	}
	if err := os.Rename(part, final); err != nil {
		return fmt.Errorf("saving preview copy: %w", err)
	}
	pruneCache(m.cacheDir, CacheLimitBytes)
	return nil
}
