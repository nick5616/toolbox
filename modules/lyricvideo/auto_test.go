package lyricvideo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// TestMain lets the test binary stand in for ffmpeg: with LV_FAKE_FFMPEG set
// it writes the file named by its last argument (the working directory is
// the job's temp dir) and reports the end of progress.
func TestMain(m *testing.M) {
	if os.Getenv("LV_FAKE_FFMPEG") == "1" {
		out := os.Args[len(os.Args)-1]
		if err := os.WriteFile(out, []byte("mp4"), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("out_time_us=1000000")
		fmt.Println("progress=end")
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func installFakeFFmpeg(t *testing.T, h *harness) {
	t.Helper()
	t.Setenv("LV_FAKE_FFMPEG", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	oldProbe := probeMedia
	t.Cleanup(func() { probeMedia = oldProbe })
	probeMedia = func(context.Context, string, string) (media.Info, error) {
		return media.Info{DurationMs: 12_000}, nil
	}
	h.setTool("ffmpeg", exe)
}

func autoOptions(mod func(*Options)) Options {
	o := DefaultOptions()
	o.Action = ActionAuto
	o.Look.Background = "color"
	o.Look.Title, o.Look.Artist = "Hello", "Me"
	if mod != nil {
		mod(&o)
	}
	return o
}

func TestRunAuto(t *testing.T) {
	h := newHarness(t, autoOptions(nil))
	installFakeFFmpeg(t, h)
	h.eng.events = []sidecar.Event{{Kind: "progress", Pct: 0.5, Msg: "working"}}
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	if want := []string{"stems.separate", "transcribe.run"}; !slices.Equal(h.eng.calls, want) {
		t.Errorf("engine calls %v, want %v", h.eng.calls, want)
	}
	if h.eng.params["transcribe.run"]["input"] == h.song {
		t.Error("lyrics are detected from the isolated vocals, not the song")
	}
	var names []string
	for _, p := range h.outs {
		names = append(names, filepath.Base(p))
	}
	if want := []string{"My Song (lyric video).mp4", "My Song.lrc"}; !slices.Equal(names, want) {
		t.Fatalf("outputs %v, want %v", names, want)
	}
	lrc, err := os.ReadFile(h.outs[1])
	if err != nil || !strings.Contains(string(lrc), "darkness") || !strings.Contains(string(lrc), "Hello") {
		t.Errorf("lrc %q err %v", lrc, err)
	}
	res := h.result_(t)
	if res.Action != ActionAuto || len(res.Lines) != 2 || res.Matched != 1 || len(res.Outputs) != 2 {
		t.Errorf("result %+v", res)
	}
	if det := slices.DeleteFunc(slices.Clone(h.prog), func(p float64) bool { return p < 0 }); !slices.IsSorted(det) {
		t.Errorf("progress not monotonic: %v", h.prog)
	}
	var lyrics, render bool
	for _, p := range h.prog {
		if p >= 0 && p <= autoLyricsEnd {
			lyrics = true
		}
		if p > autoLyricsEnd && p < 1 {
			render = true
		}
	}
	if h.prog[len(h.prog)-1] != 1 || !lyrics || !render {
		t.Errorf("progress %v should cover both bands and end at 1", h.prog)
	}
}

func TestRunAutoUsesTheLanguage(t *testing.T) {
	h := newHarness(t, autoOptions(func(o *Options) { o.Language = "es" }))
	installFakeFFmpeg(t, h)
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	if h.eng.params["transcribe.run"]["language"] != "es" {
		t.Errorf("params %v", h.eng.params["transcribe.run"])
	}
}

func TestRunAutoNoLyrics(t *testing.T) {
	h := newHarness(t, autoOptions(nil))
	installFakeFFmpeg(t, h)
	h.eng.transcript = `{"language":"en","duration":12,"segments":[]}`
	err := h.m.Run(context.Background(), h.job)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeValidation || ae.Message != "No lyrics heard" || ae.Hint != "Use Lyric Video with pasted lyrics" {
		t.Fatalf("err %v", err)
	}
	if len(h.outs) != 0 || h.result != nil {
		t.Errorf("nothing may be saved: %v", h.outs)
	}
}

func TestDetectStillSaysNoWords(t *testing.T) {
	// The lyrics action keeps its own message.
	o := DefaultOptions()
	o.Source = SourceDetect
	h := newHarness(t, o)
	h.eng.transcript = `{"language":"en","duration":12,"segments":[]}`
	err := h.m.Run(context.Background(), h.job)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Message != "No words were recognised" || ae.Hint == "" {
		t.Fatalf("err %v", err)
	}
}

func TestRunAutoEngineMissing(t *testing.T) {
	h := newHarness(t, autoOptions(nil))
	h.noTool["audio-engine"] = true
	err := h.m.Run(context.Background(), h.job)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("err %v", err)
	}
	if len(h.eng.calls) != 0 {
		t.Errorf("engine calls %v", h.eng.calls)
	}
}

func TestRunAutoWithVisuals(t *testing.T) {
	h := newHarness(t, visualOptions(ActionAuto, true))
	installFakeFFmpeg(t, h)
	fv := &fakeVisuals{}
	fv.install(t)
	// install replaced probeMedia; keep a duration for the song.
	h.m.an, h.m.br = viz.NewAnalyzer(t.TempDir(), t.TempDir(), nil, nil), &viz.RenderBroker{}
	if err := h.m.Run(context.Background(), h.job); err != nil {
		t.Fatal(err)
	}
	if len(fv.calls) != 1 || fv.calls[0].lines != 2 {
		t.Fatalf("visual calls %+v (the detected lines drive word effects)", fv.calls)
	}
	if len(h.outs) != 2 {
		t.Errorf("outputs %v", h.outs)
	}
}

func TestValidateAuto(t *testing.T) {
	dir := t.TempDir()
	song := filepath.Join(dir, "a.mp3")
	if err := os.WriteFile(song, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := &Module{}
	tests := []struct {
		name string
		mod  func(*Options)
		want string // field, "" = valid
	}{
		{"defaults", nil, ""},
		{"no lines needed", func(o *Options) { o.Lines = nil }, ""},
		{"visualizer needs a design", func(o *Options) { o.Look.Background = "visualizer" }, "look.visuals"},
		{"image needs a file", func(o *Options) { o.Look.Background = "image" }, ""}, // error carries no field map key
		{"bad aspect", func(o *Options) { o.Aspect = "4:3" }, "aspect"},
		{"bad colour", func(o *Options) { o.Look.TextColor = "red" }, "look.textColor"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := autoOptions(tt.mod)
			err := m.Validate([]string{song}, mustJSON(t, o))
			if tt.name == "image needs a file" {
				if err == nil {
					t.Error("an image background needs a file")
				}
				return
			}
			if tt.want == "" {
				if err != nil {
					t.Fatalf("unexpected %v", err)
				}
				return
			}
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Fields[tt.want] == "" {
				t.Fatalf("want field %q, got %v", tt.want, err)
			}
		})
	}
}
