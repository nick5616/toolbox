//go:build integration

package posts

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"toolbox/core/media"
	"toolbox/modules/composer"
	"toolbox/modules/videoeditor"
)

func TestExportIntegration(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe not installed")
	}
	e := newEnv(t)
	e.tools["ffmpeg"], e.tools["ffprobe"] = ffmpeg, ffprobe

	dir := t.TempDir()
	gen := func(out, dur, size string) {
		t.Helper()
		cmd := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size="+size+":rate=15",
			"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", dur,
			"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
			"-metadata", "location=+48.8584+002.2945/", out)
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v\n%s", err, b)
		}
	}
	clip := filepath.Join(dir, "long.mp4")
	gen(clip, "70", "1920x1440")

	gpsPhoto := filepath.Join(dir, "gps.jpg")
	writeJPEG(t, gpsPhoto, gradient(2000, 1500), exifPayload(6, true))
	plain := filepath.Join(dir, "plain.jpg")
	writeJPEG(t, plain, gradient(1600, 1600), nil)
	render := filepath.Join(dir, "comp.png")
	writePNG(t, render, gradient(1080, 1350))

	e.m.comps = &fakeComps{comp: composer.Composition{Aspect: "4:5", Format: "jpg"}, render: render}
	e.m.videos = &fakeVideos{doc: videoeditor.VideoProject{Aspect: "4:5"}, render: func(out string, o videoeditor.RenderOptions) error {
		cmd := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
			"testsrc2=size="+strconv.Itoa(o.Width)+"x"+strconv.Itoa(o.Height)+":rate=30", "-t", "2",
			"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out)
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("fake render: %v\n%s", err, b)
		}
		return nil
	}}

	doc := Post{Version: 1, Format: "carousel", Aspect: "4:5", Caption: "Days in Paris #travel\n日本語 ok", Slides: []Slide{
		{ID: "1", Kind: "photo", Path: gpsPhoto, Zoom: 1},
		{ID: "2", Kind: "photo", Path: plain, Zoom: 1, PanX: 0.5},
		{ID: "3", Kind: "clip", Path: clip, InMs: 5000, OutMs: 65000, Zoom: 1},
		{ID: "4", Kind: "composition", ProjectID: "c", Zoom: 1},
		{ID: "5", Kind: "video", ProjectID: "v", Zoom: 1},
	}}
	if got := e.m.Check(context.Background(), doc); len(got) != 1 || got[0].Level != "note" {
		t.Fatalf("issues %v", got)
	}
	id := e.save("Paris", doc)
	if err := e.run(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	res := e.exportResult()
	want := []string{"01.jpg", "02.jpg", "03.mp4", "04.jpg", "05.mp4", "caption.txt", "post.json"}
	entries, _ := os.ReadDir(res.Folder)
	if len(entries) != len(want) {
		t.Fatalf("folder has %v", entries)
	}
	for _, n := range want {
		if _, err := os.Stat(filepath.Join(res.Folder, n)); err != nil {
			t.Errorf("missing %s", n)
		}
	}
	for _, n := range []string{"01.jpg", "02.jpg", "04.jpg"} {
		if w, h := imageSize(t, filepath.Join(res.Folder, n)); w != 1080 || h != 1350 {
			t.Errorf("%s is %dx%d", n, w, h)
		}
		data, _ := os.ReadFile(filepath.Join(res.Folder, n))
		if _, ok := findExifSegment(data); ok {
			t.Errorf("%s has EXIF", n)
		}
	}
	for _, n := range []string{"03.mp4", "05.mp4"} {
		info, err := media.Probe(context.Background(), ffprobe, filepath.Join(res.Folder, n))
		if err != nil || info.Video == nil {
			t.Fatalf("%s: %v", n, err)
		}
		if info.Video.Width != 1080 || info.Video.Height != 1350 {
			t.Errorf("%s is %dx%d", n, info.Video.Width, info.Video.Height)
		}
		if info.DurationMs > 60_500 {
			t.Errorf("%s is %d ms", n, info.DurationMs)
		}
		if info.Tags["location"] != "" {
			t.Errorf("%s kept location metadata", n)
		}
		if n == "03.mp4" && (info.DurationMs < 59_000 || len(info.Audio) == 0) {
			t.Errorf("clip: %d ms, %d audio streams", info.DurationMs, len(info.Audio))
		}
	}
	if b, _ := os.ReadFile(filepath.Join(res.Folder, "caption.txt")); string(b) != doc.Caption {
		t.Errorf("caption %q", b)
	}
}
