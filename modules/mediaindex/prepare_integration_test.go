//go:build integration

package mediaindex

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"

	"toolbox/core"
)

func realFFmpeg(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	ffmpeg, e1 := exec.LookPath("ffmpeg")
	ffprobe, e2 := exec.LookPath("ffprobe")
	if e1 != nil || e2 != nil {
		t.Skip("FFmpeg isn't installed")
	}
	return ffmpeg, ffprobe
}

// Three static scenes of 10 s each, a 1280×720 portrait-rotated-free clip.
func TestIntegrationVideoFrames(t *testing.T) {
	ffmpeg, ffprobe := realFFmpeg(t)
	clip := filepath.Join(t.TempDir(), "scenes.mp4")
	graph := "smptebars=s=1280x720:r=10:d=10[a];rgbtestsrc=s=1280x720:r=10:d=10[b];color=c=black:s=1280x720:r=10:d=10,drawbox=x=100:y=100:w=500:h=300:color=white:t=fill[c];[a][b][c]concat=n=3:v=1:a=0[v]"
	if b, err := exec.Command(ffmpeg, "-v", "error", "-y", "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip).CombinedOutput(); err != nil {
		t.Fatalf("make clip: %v\n%s", err, b)
	}

	sched := videoSchedule(30_000)
	files, err := extractFrames(context.Background(), ffmpeg, clip, filepath.Join(t.TempDir(), "v"), sched)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != sched.Count {
		t.Errorf("extracted %d frames, want %d", len(files), sched.Count)
	}
	for _, f := range files {
		img, err := readImage(f)
		if err != nil {
			t.Fatal(err)
		}
		if b := img.Bounds(); b.Dx() != 1280 || b.Dy() != 720 {
			t.Errorf("%s = %v", filepath.Base(f), b)
		}
	}

	// Through the job: the three scenes survive the dHash dedupe, near-copies don't.
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	job := core.NewJobContext(core.JobContext{ID: "j", Inputs: []string{clip}, Options: []byte(`{"readText":false}`), TempDir: t.TempDir()}, core.JobHooks{
		Tool: func(id string) (string, error) {
			switch id {
			case "ffmpeg":
				return ffmpeg, nil
			case "ffprobe":
				return ffprobe, nil
			}
			return "/fake/" + id, nil
		},
	})
	if err := im.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	r := w.batches[0][0]
	if r.Failed != "" || len(r.Vectors) != 3 {
		t.Fatalf("result = failed %q, %d vectors", r.Failed, len(r.Vectors))
	}
	for i, v := range r.Vectors {
		if want := sched.Times()[i*5]; v.Pos != want {
			t.Errorf("vector %d at %d ms, want %d", i, v.Pos, want)
		}
	}
}
