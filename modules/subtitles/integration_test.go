//go:build integration

package subtitles

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
)

func findTools(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	ffmpeg, err1 := exec.LookPath("ffmpeg")
	ffprobe, err2 := exec.LookPath("ffprobe")
	if err1 != nil || err2 != nil {
		t.Skip("ffmpeg/ffprobe not on PATH")
	}
	return ffmpeg, ffprobe
}

func makeVideo(t *testing.T, ffmpeg, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	out, err := exec.Command(ffmpeg, "-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p).CombinedOutput()
	if err != nil {
		t.Fatalf("make video: %v\n%s", err, out)
	}
	return p
}

func realJob(t *testing.T, r *recorder, ffmpeg, ffprobe, input string, o Options) *core.JobContext {
	job := newJob(t, r, input, o)
	return core.NewJobContext(*job, core.JobHooks{
		Progress: func(p float64, _ string) { r.pcts = append(r.pcts, p) },
		Log:      func(_ core.LogStream, l string) { r.logs = append(r.logs, l) },
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) {
			if id == "ffprobe" {
				return ffprobe, nil
			}
			return ffmpeg, nil
		},
		Result: func(b json.RawMessage) { r.result = b },
	})
}

var testCues = []Cue{{0, 1200, "Hello there"}, {1500, 2800, "Second line\nof text"}}

func TestEmbedBurnExtract(t *testing.T) {
	ffmpeg, ffprobe := findTools(t)
	dir := t.TempDir()
	video := makeVideo(t, ffmpeg, dir, "clip.mp4")
	m := &Module{resolve: func(id string) (string, error) {
		if id == "ffprobe" {
			return ffprobe, nil
		}
		return ffmpeg, nil
	}}

	t.Run("embed keeps the video stream untouched and adds a track", func(t *testing.T) {
		r := &recorder{}
		o := opts(func(o *Options) { o.Action = ActionEmbed; o.Cues = testCues; o.TrackLanguage = "es" })
		if err := m.Run(context.Background(), realJob(t, r, ffmpeg, ffprobe, video, o)); err != nil {
			t.Fatal(err)
		}
		if len(r.outputs) != 1 || !strings.HasSuffix(r.outputs[0], "clip (subs).mp4") {
			t.Fatalf("outputs %v", r.outputs)
		}
		info, err := media.Probe(context.Background(), ffprobe, r.outputs[0])
		if err != nil {
			t.Fatal(err)
		}
		if info.Video == nil || info.Video.Codec != "h264" || len(info.Subtitles) != 1 || info.Subtitles[0].Language != "spa" {
			t.Errorf("probe %+v", info)
		}

		// Extract the track again.
		r2 := &recorder{}
		eo := opts(func(o *Options) { o.Action = ActionExtract; o.StreamIndex = info.Subtitles[0].Index })
		if err := m.Validate([]string{r.outputs[0]}, mustJSON(t, eo)); err != nil {
			t.Fatalf("validate extract: %v", err)
		}
		if err := m.Run(context.Background(), realJob(t, r2, ffmpeg, ffprobe, r.outputs[0], eo)); err != nil {
			t.Fatal(err)
		}
		got, err := load(r2.outputs[0])
		if err != nil || len(got) != 2 || got[1].Text != "Second line\nof text" {
			t.Errorf("extracted %+v err %v", got, err)
		}
	})

	t.Run("embed into avi remuxes to mkv", func(t *testing.T) {
		avi := filepath.Join(dir, "clip.avi")
		if out, err := exec.Command(ffmpeg, "-hide_banner", "-y", "-i", video, "-c:v", "mpeg4", "-c:a", "mp3", avi).CombinedOutput(); err != nil {
			t.Skipf("can't make avi: %v\n%s", err, out)
		}
		r := &recorder{}
		o := opts(func(o *Options) { o.Action = ActionEmbed; o.Cues = testCues })
		if err := m.Run(context.Background(), realJob(t, r, ffmpeg, ffprobe, avi, o)); err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(r.outputs[0], "clip (subs).mkv") {
			t.Errorf("outputs %v", r.outputs)
		}
	})

	t.Run("burn renders an mp4", func(t *testing.T) {
		r := &recorder{}
		o := opts(func(o *Options) { o.Action = ActionBurn; o.Cues = testCues; o.Style = StyleBoxed })
		if err := m.Run(context.Background(), realJob(t, r, ffmpeg, ffprobe, video, o)); err != nil {
			t.Fatal(err)
		}
		if len(r.outputs) != 1 || !strings.HasSuffix(r.outputs[0], "clip (subtitled).mp4") {
			t.Fatalf("outputs %v", r.outputs)
		}
		info, err := media.Probe(context.Background(), ffprobe, r.outputs[0])
		if err != nil || info.Video == nil || info.Video.Width != 320 || len(info.Audio) != 1 || len(info.Subtitles) != 0 {
			t.Errorf("probe %+v err %v", info, err)
		}
		if st, err := os.Stat(r.outputs[0]); err != nil || st.Size() == 0 {
			t.Errorf("stat %v", err)
		}
	})

	t.Run("validate rejects burning an audio file", func(t *testing.T) {
		wav := filepath.Join(dir, "tone.wav")
		if out, err := exec.Command(ffmpeg, "-hide_banner", "-y", "-f", "lavfi", "-i", "sine=duration=1", wav).CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		o := opts(func(o *Options) { o.Action = ActionBurn; o.Cues = testCues })
		if err := m.Validate([]string{wav}, mustJSON(t, o)); err == nil {
			t.Error("expected a validation error")
		}
	})

	t.Run("cancel stops the render", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		o := opts(func(o *Options) { o.Action = ActionBurn; o.Cues = testCues })
		r := &recorder{}
		if err := m.Run(ctx, realJob(t, r, ffmpeg, ffprobe, video, o)); err == nil {
			t.Error("expected an error")
		}
		if len(r.outputs) != 0 {
			t.Errorf("outputs after cancel: %v", r.outputs)
		}
	})
}

func mustJSON(t *testing.T, o Options) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
