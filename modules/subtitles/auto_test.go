package subtitles

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

func progressEvent(p float64) sidecar.Event { return sidecar.Event{Kind: "progress", Pct: p, Msg: "x"} }

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func engineCaller(t *testing.T, json string) *fakeCaller {
	t.Helper()
	return &fakeCaller{
		result: `{"language":"en"}`,
		events: nil,
		onCall: func(p map[string]any) {
			writeFile(t, p["outputDir"].(string), p["baseName"].(string)+".json", json)
		},
	}
}

func autoOpts(mod func(*Options)) Options {
	return opts(func(o *Options) {
		o.Action = ActionAuto
		o.Video = VideoNone
		o.Formats = []string{"srt"}
		mod(o)
	})
}

func TestRunAutoTranslateSaveBurn(t *testing.T) {
	video := media.Info{DurationMs: 60000, Video: &media.VideoStream{Width: 1280, Height: 720}, Audio: []media.AudioStream{{Codec: "aac"}}}
	f := installFakes(t, video)
	in := writeFile(t, t.TempDir(), "clip.mp4", "x")
	o := autoOpts(func(o *Options) {
		o.Formats = []string{"srt", "vtt"}
		o.Video = VideoBurn
		o.Language = "en"
		o.TargetLanguage = "es"
		o.MaxSizeMB = 20
	})
	r := &recorder{}
	fc := engineCaller(t, engineJSON)
	fc.events = nil
	tg := &fakeTG{reply: echoUpper}
	m := &Module{sc: fc, tg: tg, modelsDir: "models"}
	if err := m.Run(context.Background(), newJob(t, r, in, o)); err != nil {
		t.Fatal(err)
	}
	if fc.method != "transcribe.run" {
		t.Errorf("method %q", fc.method)
	}
	var names []string
	for _, p := range r.outputs {
		names = append(names, filepath.Base(p))
	}
	if want := []string{"clip.es.srt", "clip.es.vtt", "clip (subtitled).mp4"}; !slices.Equal(names, want) {
		t.Fatalf("outputs %v, want %v", names, want)
	}
	// The saved subtitles are the translation.
	saved, err := load(r.outputs[0])
	if err != nil || len(saved) != 2 || saved[0].Text != strings.ToUpper(saved[0].Text) {
		t.Errorf("saved %+v err %v", saved, err)
	}
	if len(f.ffmpeg) != 1 {
		t.Fatalf("ffmpeg runs %d", len(f.ffmpeg))
	}
	joined := strings.Join(f.ffmpeg[0], " ")
	for _, want := range []string{"-vf ass=subs.ass", "-b:v", "-maxrate", "-c:a aac -b:a 128k"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
	if strings.Contains(joined, "-crf") {
		t.Errorf("a size limit must replace -crf: %s", joined)
	}
	res := r.res(t)
	if res.Action != ActionAuto || res.Language != "es" || res.Cues != 2 || len(res.Outputs) != 3 {
		t.Errorf("result %+v", res)
	}
	// Progress never goes backwards between the three bands and ends at 1.
	if !slices.IsSorted(r.pcts) {
		t.Errorf("progress not monotonic: %v", r.pcts)
	}
	if last := r.pcts[len(r.pcts)-1]; last != 1 {
		t.Errorf("final progress %v", last)
	}
	bands := map[string]bool{}
	for _, p := range r.pcts {
		switch {
		case p <= autoGenerateEnd:
			bands["generate"] = true
		case p <= autoTranslateEnd:
			bands["translate"] = true
		default:
			bands["video"] = true
		}
	}
	if len(bands) != 3 {
		t.Errorf("progress bands seen %v from %v", bands, r.pcts)
	}
	if len(tg.reqs) == 0 {
		t.Error("translation never ran")
	}
}

func TestRunAutoEngineProgressBand(t *testing.T) {
	in := writeFile(t, t.TempDir(), "clip.mp4", "x")
	r := &recorder{}
	fc := engineCaller(t, engineJSON)
	fc.events = nil
	fc.events = append(fc.events, progressEvent(1))
	m := &Module{sc: fc}
	if err := m.Run(context.Background(), newJob(t, r, in, autoOpts(func(*Options) {}))); err != nil {
		t.Fatal(err)
	}
	for _, p := range r.pcts[:len(r.pcts)-1] {
		if p > autoGenerateEnd+1e-9 && p != autoTranslateEnd {
			t.Errorf("generate progress %v is outside 0-60 %% (all: %v)", p, r.pcts)
		}
	}
}

func TestRunAutoSaveOnly(t *testing.T) {
	in := writeFile(t, t.TempDir(), "talk.mp3", "x")
	r := &recorder{}
	m := &Module{sc: engineCaller(t, engineJSON)}
	if err := m.Run(context.Background(), newJob(t, r, in, autoOpts(func(*Options) {}))); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "talk.srt" {
		t.Fatalf("outputs %v", r.outputs)
	}
	if res := r.res(t); res.Action != ActionAuto || res.Language != "en" || res.Cues != 2 {
		t.Errorf("result %+v", res)
	}
}

func TestRunAutoNoSpeech(t *testing.T) {
	in := writeFile(t, t.TempDir(), "silence.mp3", "x")
	r := &recorder{}
	m := &Module{sc: engineCaller(t, `{"language":"en","segments":[]}`)}
	err := m.Run(context.Background(), newJob(t, r, in, autoOpts(func(*Options) {})))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeValidation || ae.Message != "No speech found" || ae.Hint != "Check the audio has speech" {
		t.Fatalf("err %v", err)
	}
	if len(r.outputs) != 0 || r.result != nil {
		t.Errorf("nothing may be saved: %v", r.outputs)
	}
}

func TestRunAutoTranslateNotReady(t *testing.T) {
	in := writeFile(t, t.TempDir(), "talk.mp3", "x")
	r := &recorder{}
	tg := &fakeTG{reply: echoUpper, readyErr: core.ErrDependencyMissing("chat model", "")}
	m := &Module{sc: engineCaller(t, engineJSON), tg: tg}
	err := m.Run(context.Background(), newJob(t, r, in, autoOpts(func(o *Options) { o.TargetLanguage = "fr" })))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing || ae.Hint != openChatHint {
		t.Fatalf("err %v", err)
	}
	if len(r.outputs) != 0 || len(tg.reqs) != 0 {
		t.Errorf("outputs %v requests %d", r.outputs, len(tg.reqs))
	}
}

func TestRunAutoSameLanguageSkipsTranslation(t *testing.T) {
	in := writeFile(t, t.TempDir(), "talk.mp3", "x")
	r := &recorder{}
	tg := &fakeTG{reply: echoUpper}
	m := &Module{sc: engineCaller(t, engineJSON), tg: tg}
	// Whisper translates to English, so an English target needs no second step.
	o := autoOpts(func(o *Options) { o.TranslateToEnglish = true; o.TargetLanguage = "en" })
	if err := m.Run(context.Background(), newJob(t, r, in, o)); err != nil {
		t.Fatal(err)
	}
	if len(tg.reqs) != 0 || filepath.Base(r.outputs[0]) != "talk.srt" {
		t.Errorf("requests %d outputs %v", len(tg.reqs), r.outputs)
	}
}

func TestRunAutoBurnAudioFallsBackToColour(t *testing.T) {
	// A burn from audio with the colour background runs FFmpeg once.
	audio := media.Info{DurationMs: 30000, Audio: []media.AudioStream{{Codec: "mp3"}}}
	f := installFakes(t, audio)
	in := writeFile(t, t.TempDir(), "song.mp3", "x")
	r := &recorder{}
	m := &Module{sc: engineCaller(t, engineJSON)}
	o := autoOpts(func(o *Options) { o.Video = VideoBurn; o.Background = "color" })
	if err := m.Run(context.Background(), newJob(t, r, in, o)); err != nil {
		t.Fatal(err)
	}
	if len(f.ffmpeg) != 1 || !strings.Contains(strings.Join(f.ffmpeg[0], " "), "color=c=0x11131a") {
		t.Fatalf("ffmpeg %v", f.ffmpeg)
	}
	if len(r.outputs) != 2 {
		t.Errorf("outputs %v", r.outputs)
	}
}

func TestValidateAuto(t *testing.T) {
	tests := []struct {
		name    string
		mod     func(*Options)
		wantErr string // field, "" = valid
	}{
		{"save only", func(o *Options) {}, ""},
		{"burn only", func(o *Options) { o.Formats = nil; o.Video = VideoBurn }, ""},
		{"embed only", func(o *Options) { o.Formats = nil; o.Video = VideoEmbed }, ""},
		{"nothing to make", func(o *Options) { o.Formats = nil }, "formats"},
		{"unknown video", func(o *Options) { o.Video = "gif" }, "video"},
		{"bad format", func(o *Options) { o.Formats = []string{"ass"} }, "formats"},
		{"duplicate format", func(o *Options) { o.Formats = []string{"srt", "srt"} }, "formats"},
		{"bad model", func(o *Options) { o.Model = "huge" }, "model"},
		{"bad target", func(o *Options) { o.TargetLanguage = "xx" }, "targetLanguage"},
		{"target equals language", func(o *Options) { o.Language = "es"; o.TargetLanguage = "es" }, "targetLanguage"},
		{"size limit 4000", func(o *Options) { o.Video = VideoBurn; o.MaxSizeMB = 4000 }, ""},
		{"size limit 4001", func(o *Options) { o.Video = VideoBurn; o.MaxSizeMB = 4001 }, "maxSizeMB"},
		{"size limit negative", func(o *Options) { o.Video = VideoBurn; o.MaxSizeMB = -1 }, "maxSizeMB"},
		{"burn bad style", func(o *Options) { o.Video = VideoBurn; o.Style = "neon" }, "style"},
		{"burn bad canvas", func(o *Options) { o.Video = VideoBurn; o.Canvas = "4:3" }, "canvas"},
		{"embed bad track language", func(o *Options) { o.Video = VideoEmbed; o.TrackLanguage = "xx" }, "trackLanguage"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateOptions(autoOpts(tt.mod))
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
				return
			}
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Fields[tt.wantErr] == "" {
				t.Fatalf("want field %q, got %v", tt.wantErr, err)
			}
		})
	}
}

func TestValidateAutoInputs(t *testing.T) {
	dir := t.TempDir()
	srt := writeFile(t, dir, "a.srt", "x")
	mp3 := writeFile(t, dir, "a.mp3", "x")
	m := &Module{}
	raw := func(o Options) []byte { return mustJSON(t, o) }
	err := m.Validate([]string{srt}, raw(autoOpts(func(*Options) {})))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Fields["inputs.0"] == "" {
		t.Errorf("an .srt must be rejected for auto: %v", err)
	}
	if err := m.Validate([]string{mp3}, raw(autoOpts(func(*Options) {}))); err != nil {
		t.Errorf("audio is fine: %v", err)
	}
}

func TestCheckStreamsAuto(t *testing.T) {
	audio := media.Info{Audio: []media.AudioStream{{Codec: "mp3"}}}
	video := media.Info{Video: &media.VideoStream{Width: 10, Height: 10}}
	tests := []struct {
		name string
		o    Options
		info media.Info
		bad  bool
	}{
		{"embed needs video", autoOpts(func(o *Options) { o.Video = VideoEmbed }), audio, true},
		{"embed video", autoOpts(func(o *Options) { o.Video = VideoEmbed }), video, false},
		{"burn audio without background", autoOpts(func(o *Options) { o.Video = VideoBurn }), audio, true},
		{"burn audio colour", autoOpts(func(o *Options) { o.Video = VideoBurn; o.Background = "color" }), audio, false},
		{"burn video", autoOpts(func(o *Options) { o.Video = VideoBurn }), video, false},
		{"save only on audio", autoOpts(func(*Options) {}), audio, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := checkStreams(tt.o, tt.info)
			if (err != nil) != tt.bad {
				t.Errorf("err %v, bad=%v", err, tt.bad)
			}
		})
	}
}

func TestCapArgs(t *testing.T) {
	base := burnArgs("in.mp4", "out.mp4", "aac")
	if got, err := capArgs(base, 0, 60); err != nil || !slices.Equal(got, base) {
		t.Errorf("no limit must leave args alone: %v %v", got, err)
	}
	got, err := capArgs(base, 10, 60)
	if err != nil {
		t.Fatal(err)
	}
	j := strings.Join(got, " ")
	// 10 MB over 60 s with 128 kbit/s audio: about 1.2 Mbit/s of video.
	if !strings.Contains(j, "-b:v 1") || strings.Contains(j, "-crf") || strings.Contains(j, "-c:a copy") {
		t.Errorf("args %s", j)
	}
	if _, err := capArgs(base, 1, 3600); err == nil {
		t.Error("a limit too small for the length must fail")
	}
}
