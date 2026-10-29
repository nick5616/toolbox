//go:build integration

package api

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
)

const pinnedFFmpegDir = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\smoke\bin\ffmpeg`

func TestRealFFmpegProxyAndFilmstrip(t *testing.T) {
	ffmpeg := filepath.Join(pinnedFFmpegDir, "ffmpeg.exe")
	ffprobe := filepath.Join(pinnedFFmpegDir, "ffprobe.exe")
	if _, err := os.Stat(ffmpeg); err != nil {
		t.Skip("pinned FFmpeg not found")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "clip.mkv")
	out, err := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=2",
		"-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", src).CombinedOutput()
	if err != nil {
		t.Fatalf("generate: %v %s", err, out)
	}
	paths := core.Paths{CacheDir: filepath.Join(dir, "cache")}
	resolve := func(id string) (string, error) {
		if id == "ffprobe" {
			return ffprobe, nil
		}
		return ffmpeg, nil
	}
	s := &MediaService{Paths: paths, Resolve: resolve, GOOS: "windows"}

	reg := core.NewRegistry()
	mod, err := media.RegisterProxy(reg, media.CacheDir(paths))
	if err != nil {
		t.Fatal(err)
	}
	job := core.NewJobContext(core.JobContext{ID: "t1", Inputs: []string{src}, Options: []byte("{}")},
		core.JobHooks{Tool: resolve})
	if err := mod.Run(context.Background(), job); err != nil {
		t.Fatalf("proxy run: %v", err)
	}
	fi, _ := os.Stat(src)
	pp := media.ProxyPath(media.CacheDir(paths), src, fi.Size(), fi.ModTime().UnixNano(), false)
	if pfi, err := os.Stat(pp); err != nil || pfi.Size() == 0 {
		t.Fatalf("proxy missing: %v", err)
	}
	// Cached copy is now what Open returns (mkv is not playable on windows).
	s.submit = func(context.Context, string, []string, string) ([]core.Job, error) {
		t.Error("should not submit")
		return nil, nil
	}
	s.list = func(context.Context, core.JobFilter) ([]core.Job, error) { return nil, nil }
	if src2, err := s.Open(src); err != nil || !src2.Proxy {
		t.Fatalf("open: %v %+v", err, src2)
	}
	if u, err := s.Filmstrip(src, 8, 60); err != nil || u == "" {
		t.Fatalf("filmstrip: %v", err)
	}
	if u, err := s.Frame(src, 500, 320); err != nil || u == "" {
		t.Fatalf("frame: %v", err)
	}
	peaks, err := s.Waveform(src, 100)
	if err != nil || len(peaks) != 100 {
		t.Fatalf("waveform: %v", err)
	}
}
