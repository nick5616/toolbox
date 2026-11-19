package editstudio

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/proc"
	"toolbox/core/viz"
)

func TestResolveExport(t *testing.T) {
	doc := NewProject("9:16", 30, 1)
	cases := []struct {
		name string
		ex   *ExportSettings
		want exportParams
	}{
		{"none", nil, exportParams{FPS: 30, Codec: "h264", Quality: "good", CRF: 20, Preset: "fast", AudioKbps: 192}},
		{"zero value", &ExportSettings{}, exportParams{FPS: 30, Codec: "h264", Quality: "good", CRF: 20, Preset: "fast", AudioKbps: 192, Custom: true}},
		{"draft h264", &ExportSettings{Quality: "draft", Codec: "h264", FPS: 24, AudioKbps: 128},
			exportParams{FPS: 24, Codec: "h264", Quality: "draft", CRF: 26, Preset: "veryfast", AudioKbps: 128, Custom: true}},
		{"best h265", &ExportSettings{Quality: "best", Codec: "h265", AudioKbps: 320},
			exportParams{FPS: 30, Codec: "h265", Quality: "best", CRF: 20, Preset: "medium", AudioKbps: 320, Custom: true}},
		{"good h265", &ExportSettings{Quality: "good", Codec: "h265"},
			exportParams{FPS: 30, Codec: "h265", Quality: "good", CRF: 24, Preset: "fast", AudioKbps: 192, Custom: true}},
		{"draft h265", &ExportSettings{Quality: "draft", Codec: "h265"},
			exportParams{FPS: 30, Codec: "h265", Quality: "draft", CRF: 30, Preset: "veryfast", AudioKbps: 192, Custom: true}},
		{"range", &ExportSettings{InMs: 1000, OutMs: 4000},
			exportParams{FPS: 30, Codec: "h264", Quality: "good", CRF: 20, Preset: "fast", AudioKbps: 192, Custom: true, Ranged: true, InMs: 1000, OutMs: 4000}},
	}
	for _, tc := range cases {
		d := doc
		d.Export = tc.ex
		if got := resolveExport(d); got != tc.want {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
	p := resolveExport(EditProject{FPS: 60, Export: &ExportSettings{Codec: "h265", Quality: "best"}}).withH264()
	if p.Codec != "h264" || p.CRF != 16 {
		t.Errorf("fallback = %+v", p)
	}
	if got := (exportParams{Ranged: true, InMs: 1000, OutMs: 3500}).lengthMs(30_000); got != 2500 {
		t.Errorf("lengthMs = %d", got)
	}
	if got := (exportParams{}).lengthMs(30_000); got != 30_000 {
		t.Errorf("lengthMs whole = %d", got)
	}
}

func TestExportParamsApplyTo(t *testing.T) {
	plan := viz.RenderPlan{FPS: 30, StartMs: 10_000, EndMs: 40_000}
	resolveExport(EditProject{FPS: 30}).applyTo(&plan)
	if plan.FPS != 30 || plan.StartMs != 10_000 || plan.EndMs != 40_000 {
		t.Errorf("whole = %+v", plan)
	}
	resolveExport(EditProject{FPS: 30, Export: &ExportSettings{FPS: 60, InMs: 2000, OutMs: 6000}}).applyTo(&plan)
	if plan.FPS != 60 || plan.StartMs != 12_000 || plan.EndMs != 16_000 {
		t.Errorf("range = %+v", plan)
	}
}

func TestEditMuxArgs(t *testing.T) {
	out := viz.RenderOutput{Path: "render.h264", Codec: "h264", Frames: 90}
	join := func(a []string) string { return strings.Join(a, " ") }
	t.Run("copy", func(t *testing.T) {
		got := join(editMuxArgs(out, "mix.wav", muxSpec{FPS: 30, Codec: "h264", CRF: 20, Preset: "fast", AudioKbps: 192}, "edit.mp4"))
		for _, want := range []string{"-f h264 -framerate 30 -i render.h264 -i mix.wav", "-map 0:v:0 -map 1:a:0", "-c:v copy", "-c:a aac -b:a 192k",
			"-avoid_negative_ts make_zero", "-t 3", "-movflags +faststart edit.mp4"} {
			if !strings.Contains(got, want) {
				t.Errorf("lacks %q: %s", want, got)
			}
		}
		if strings.Contains(got, "libx26") {
			t.Errorf("re-encoded: %s", got)
		}
	})
	t.Run("h264 quality", func(t *testing.T) {
		got := join(editMuxArgs(out, "mix.wav", muxSpec{FPS: 24, Codec: "h264", CRF: 26, Preset: "veryfast", AudioKbps: 128, Reencode: true}, "edit.mp4"))
		for _, want := range []string{"-framerate 24", "-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p", "-b:a 128k", "-t 3.75"} {
			if !strings.Contains(got, want) {
				t.Errorf("lacks %q: %s", want, got)
			}
		}
		if strings.Contains(got, "-c:v copy") || strings.Contains(got, "make_zero") {
			t.Errorf("copied: %s", got)
		}
	})
	t.Run("h265", func(t *testing.T) {
		got := join(editMuxArgs(out, "mix.wav", muxSpec{FPS: 60, Codec: "h265", CRF: 20, Preset: "medium", AudioKbps: 320, Reencode: true}, "edit.mp4"))
		for _, want := range []string{"-c:v libx265 -preset medium -crf 20 -pix_fmt yuv420p -tag:v hvc1", "-b:a 320k"} {
			if !strings.Contains(got, want) {
				t.Errorf("lacks %q: %s", want, got)
			}
		}
	})
	t.Run("range trims the mix, not the picture", func(t *testing.T) {
		a := editMuxArgs(out, "mix.wav", muxSpec{FPS: 30, Codec: "h264", CRF: 20, Preset: "fast", AudioKbps: 192, Reencode: true, AudioStartMs: 2000, AudioLenMs: 3000}, "edit.mp4")
		got := join(a)
		if !strings.Contains(got, "-i render.h264 -ss 2 -t 3 -i mix.wav") {
			t.Errorf("args: %s", got)
		}
	})
	t.Run("a JPEG stream is always re-encoded", func(t *testing.T) {
		got := join(editMuxArgs(viz.RenderOutput{Path: "r.mjpeg", Codec: "mjpeg"}, "mix.wav", muxSpec{FPS: 30, Codec: "h264", CRF: 20, Preset: "fast"}, "edit.mp4"))
		if !strings.Contains(got, "-f mjpeg") || !strings.Contains(got, "libx264") || !strings.Contains(got, "-shortest") || !strings.Contains(got, "-b:a 192k") {
			t.Errorf("args: %s", got)
		}
	})
}

func TestAudioOnlyArgs(t *testing.T) {
	got := strings.Join(audioOnlyArgs("mix.wav", 320, 2000, 3000, "edit.m4a"), " ")
	for _, want := range []string{"-ss 2 -t 3 -i mix.wav", "-vn -c:a aac -b:a 320k -ar 48000", "-movflags +faststart edit.m4a"} {
		if !strings.Contains(got, want) {
			t.Errorf("lacks %q: %s", want, got)
		}
	}
	if got := strings.Join(audioOnlyArgs("mix.wav", 0, 0, 0, "o.m4a"), " "); strings.Contains(got, "-ss") || !strings.Contains(got, "-b:a 192k") {
		t.Errorf("whole mix: %s", got)
	}
}

func TestFFmpegHasEncoder(t *testing.T) {
	old := runFFmpeg
	t.Cleanup(func() { runFFmpeg = old })
	calls := 0
	runFFmpeg = func(_ context.Context, s proc.Spec) (proc.Result, error) {
		calls++
		s.OnStdout(" V....D libx264              libx264 H.264")
		s.OnStdout(" V....D libx265              libx265 H.265 / HEVC")
		return proc.Result{}, nil
	}
	if !ffmpegHasEncoder(context.Background(), "ffmpeg-enc-test", "libx265") || !ffmpegHasEncoder(context.Background(), "ffmpeg-enc-test", "libx265") || calls != 1 {
		t.Errorf("libx265 (calls %d)", calls)
	}
	if ffmpegHasEncoder(context.Background(), "ffmpeg-enc-test", "libsvtav1") {
		t.Error("libsvtav1 reported")
	}
}

// saveDoc stores env.doc under the project.
func (e *exportEnv) saveDoc(t *testing.T) {
	t.Helper()
	if _, err := e.m.docs.Save(context.Background(), e.id, "My: Edit", e.doc); err != nil {
		t.Fatal(err)
	}
}

func TestRunRenderExportSettings(t *testing.T) {
	t.Run("h265 with a range and a new rate", func(t *testing.T) {
		env := newExportEnv(t)
		env.doc.Export = &ExportSettings{FPS: 60, Codec: "h265", Quality: "best", AudioKbps: 320, InMs: 2000, OutMs: 6000}
		env.saveDoc(t)
		exportEncoderFn = func(_ context.Context, ffmpeg, name string) bool { return name == "libx265" && ffmpeg == "ffmpeg-bin" }
		t.Cleanup(func() { exportEncoderFn = ffmpegHasEncoder })
		if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
			t.Fatal(err)
		}
		if p := env.plan; p.FPS != 60 || p.StartMs != 12_000 || p.EndMs != 16_000 {
			t.Errorf("plan: fps %d range %d..%d", p.FPS, p.StartMs, p.EndMs)
		}
		want := muxSpec{FPS: 60, Codec: "h265", CRF: 20, Preset: "medium", AudioKbps: 320, Reencode: true, AudioStartMs: 2000, AudioLenMs: 4000}
		if env.mux != want {
			t.Errorf("mux = %+v\nwant  %+v", env.mux, want)
		}
		// The streams stay at the project's rate; the renderer resamples.
		if st := env.plan.Edit.Streams["v:"+env.doc.Tracks[0].Clips[0].Path]; st.Stream == "" {
			t.Error("no stream in the plan")
		}
		var res Result
		_ = json.Unmarshal(env.rec.result, &res)
		if res.Speed != 4000.0/1000/10 { // the range, 10 s of wall time
			t.Errorf("speed = %v", res.Speed)
		}
	})
	t.Run("no libx265: H.264 and a log line", func(t *testing.T) {
		env := newExportEnv(t)
		env.doc.Export = &ExportSettings{Codec: "h265", Quality: "good"}
		env.saveDoc(t)
		exportEncoderFn = func(context.Context, string, string) bool { return false }
		t.Cleanup(func() { exportEncoderFn = ffmpegHasEncoder })
		if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
			t.Fatal(err)
		}
		if env.mux.Codec != "h264" || env.mux.CRF != 20 || !env.mux.Reencode {
			t.Errorf("mux = %+v", env.mux)
		}
		if !strings.Contains(strings.Join(env.rec.logs, "\n"), "libx265") {
			t.Errorf("logs = %v", env.rec.logs)
		}
	})
	t.Run("an invalid range is refused before any work", func(t *testing.T) {
		env := newExportEnv(t)
		env.doc.Export = &ExportSettings{InMs: 5000, OutMs: 4000}
		env.saveDoc(t)
		if err := env.m.runRender(context.Background(), env.job, env.id); err == nil || env.renders != 0 || env.streams != 0 {
			t.Fatalf("err = %v renders %d streams %d", err, env.renders, env.streams)
		}
	})
}

func TestRunRenderUsesSizeAndTheVideoLimit(t *testing.T) {
	t.Run("Size wins over the aspect", func(t *testing.T) {
		env := newExportEnv(t)
		env.doc.Size = &Size{W: 1280, H: 720}
		env.saveDoc(t)
		if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
			t.Fatal(err)
		}
		if env.plan.Width != 1280 || env.plan.Height != 720 {
			t.Errorf("plan size = %dx%d", env.plan.Width, env.plan.Height)
		}
	})
	t.Run("2160 is a valid export height", func(t *testing.T) {
		env := newExportEnv(t)
		env.doc.Aspect, env.doc.ExportHeight = "16:9", 2160
		env.saveDoc(t)
		if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
			t.Fatal(err)
		}
		if env.plan.Width != 3840 || env.plan.Height != 2160 {
			t.Errorf("plan size = %dx%d", env.plan.Width, env.plan.Height)
		}
	})
	t.Run("a video over 3840 is refused", func(t *testing.T) {
		env := newExportEnv(t)
		env.doc.Size = &Size{W: 4096, H: 2160}
		env.saveDoc(t)
		err := env.m.runRender(context.Background(), env.job, env.id)
		var ae *core.AppError
		if !errors.As(err, &ae) || env.renders != 0 {
			t.Fatalf("err = %v renders %d", err, env.renders)
		}
		if _, ok := ae.Fields["size"]; !ok {
			t.Errorf("fields = %v", ae.Fields)
		}
	})
}

// ---- audio only ----

type audioCall struct {
	mix                 string
	kbps                int
	startMs, lenMs, dur int64
}

func stubAudioEncode(t *testing.T) *[]audioCall {
	t.Helper()
	old := exportAudioFn
	t.Cleanup(func() { exportAudioFn = old })
	var calls []audioCall
	exportAudioFn = func(_ context.Context, ffmpeg, mix string, kbps int, startMs, lenMs, durMs int64, dst string, on func(float64)) error {
		if ffmpeg != "ffmpeg-bin" {
			t.Errorf("ffmpeg = %s", ffmpeg)
		}
		calls = append(calls, audioCall{mix, kbps, startMs, lenMs, durMs})
		on(1)
		return os.WriteFile(dst, []byte("m4a"), 0o644)
	}
	return &calls
}

func TestRunRenderAudio(t *testing.T) {
	env := newExportEnv(t)
	calls := stubAudioEncode(t)
	env.doc.Export = &ExportSettings{AudioKbps: 320, InMs: 1000, OutMs: 4000}
	env.saveDoc(t)
	env.job = newJob(t, env.dir, Options{Action: ActionRenderAudio, ProjectID: env.id}, env.rec, nil)

	if err := env.m.runRenderAudio(context.Background(), env.job, env.id); err != nil {
		t.Fatal(err)
	}
	if env.renders != 0 || env.muxes != 0 || env.streams != 0 || env.mixes != 1 {
		t.Errorf("renders %d muxes %d streams %d mixes %d", env.renders, env.muxes, env.streams, env.mixes)
	}
	if len(*calls) != 1 || (*calls)[0] != (audioCall{filepath.Join(env.job.TempDir, "mix.wav"), 320, 1000, 3000, 3000}) {
		t.Errorf("encode = %+v", *calls)
	}
	if len(env.rec.outputs) != 1 || filepath.Base(env.rec.outputs[0]) != "My_ Edit.m4a" || filepath.Dir(env.rec.outputs[0]) != env.job.OutputDir {
		t.Fatalf("outputs = %v", env.rec.outputs)
	}
	if b, _ := os.ReadFile(env.rec.outputs[0]); string(b) != "m4a" {
		t.Errorf("content = %q", b)
	}
	var res Result
	if err := json.Unmarshal(env.rec.result, &res); err != nil || res.Action != ActionRenderAudio || !slices.Equal(res.Outputs, env.rec.outputs) {
		t.Errorf("result = %+v %v", res, err)
	}
	if env.rec.title != "Exporting audio — My: Edit" {
		t.Errorf("title = %q", env.rec.title)
	}
	// A second export never overwrites the first.
	if err := env.m.runRenderAudio(context.Background(), env.job, env.id); err != nil {
		t.Fatal(err)
	}
	if env.rec.outputs[0] == env.rec.outputs[1] {
		t.Error("overwrote the first file")
	}
}

func TestRunRenderAudioWholeEditAndAudioOnlyEdits(t *testing.T) {
	env := newExportEnv(t)
	calls := stubAudioEncode(t)
	// An edit with no song and only an audio clip.
	voice := filepath.Join(env.dir, "voice.wav")
	if err := os.WriteFile(voice, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	env.doc.Song, env.doc.AnalysisKey = nil, ""
	env.doc.Tracks = []Track{{ID: "a1", Kind: "audio", Clips: []Clip{{ID: "x1", Kind: "audio", Path: voice, StartMs: 0, EndMs: 5000, Volume: 1}}}}
	env.saveDoc(t)
	if err := env.m.runRenderAudio(context.Background(), env.job, env.id); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].kbps != 192 || (*calls)[0].startMs != 0 || (*calls)[0].lenMs != 0 || (*calls)[0].dur != 5000 {
		t.Errorf("encode = %+v", *calls)
	}
}

func TestRunRenderAudioRefusals(t *testing.T) {
	t.Run("nothing to hear", func(t *testing.T) {
		env := newExportEnv(t)
		stubAudioEncode(t)
		env.doc.Song, env.doc.AnalysisKey = nil, ""
		env.doc.Tracks[0].Muted = true
		env.saveDoc(t)
		if err := env.m.runRenderAudio(context.Background(), env.job, env.id); err == nil || env.mixes != 0 {
			t.Fatalf("err = %v mixes %d", err, env.mixes)
		}
	})
	t.Run("a missing file", func(t *testing.T) {
		env := newExportEnv(t)
		stubAudioEncode(t)
		env.doc.Tracks[0].Clips[0].Path = filepath.Join(env.dir, "gone.mov")
		env.saveDoc(t)
		err := env.m.runRenderAudio(context.Background(), env.job, env.id)
		if err == nil || !strings.Contains(err.Error(), "gone.mov") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("cancel while encoding leaves nothing", func(t *testing.T) {
		env := newExportEnv(t)
		ctx, cancel := context.WithCancel(context.Background())
		old := exportAudioFn
		t.Cleanup(func() { exportAudioFn = old })
		exportAudioFn = func(ctx context.Context, _, _ string, _ int, _, _, _ int64, dst string, _ func(float64)) error {
			_ = os.WriteFile(dst, []byte("partial"), 0o644)
			cancel()
			return ctx.Err()
		}
		err := env.m.runRenderAudio(ctx, env.job, env.id)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
		ents, _ := os.ReadDir(env.job.OutputDir)
		if len(ents) != 0 || len(env.rec.outputs) != 0 {
			t.Errorf("library %d files, outputs %v", len(ents), env.rec.outputs)
		}
	})
}

// ---- still ----

func stubStill(t *testing.T, env *exportEnv) {
	t.Helper()
	exportRenderFn = func(_ context.Context, _ *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
		env.renders++
		env.plan = &plan
		p := filepath.Join(job.TempDir, "still.png")
		if err := os.WriteFile(p, []byte("png"), 0o644); err != nil {
			t.Fatal(err)
		}
		return viz.RenderOutput{Path: p, Codec: "png", Encoder: "png"}, nil
	}
}

func TestRunRenderStill(t *testing.T) {
	env := newExportEnv(t)
	stubStill(t, env)
	env.doc.Size = &Size{W: 2000, H: 1000}
	env.saveDoc(t)
	env.job = newJob(t, env.dir, Options{Action: ActionRenderStill, ProjectID: env.id, Still: &StillRequest{AtMs: 2500}}, env.rec, nil)

	if err := env.m.runRenderStill(context.Background(), env.job, env.id, StillRequest{AtMs: 2500}); err != nil {
		t.Fatal(err)
	}
	p := env.plan
	if p.Still == nil || p.Still.AtMs != 2500 || p.Still.Format != "png" || p.Edit == nil || p.Width != 2000 || p.Height != 1000 || p.FPS != 30 {
		t.Errorf("plan = %+v still %+v", p, p.Still)
	}
	if env.muxes != 0 || env.mixes != 0 {
		t.Errorf("a still mixed audio or muxed: %d %d", env.mixes, env.muxes)
	}
	if len(env.rec.outputs) != 1 || filepath.Base(env.rec.outputs[0]) != "My_ Edit.png" || filepath.Dir(env.rec.outputs[0]) != env.job.OutputDir {
		t.Fatalf("outputs = %v", env.rec.outputs)
	}
	if b, _ := os.ReadFile(env.rec.outputs[0]); string(b) != "png" {
		t.Errorf("content = %q", b)
	}
	var res Result
	if err := json.Unmarshal(env.rec.result, &res); err != nil || res.Action != ActionRenderStill || len(res.Outputs) != 1 {
		t.Errorf("result = %+v %v", res, err)
	}
}

func TestRunRenderStillDefaultsToTheExportSize(t *testing.T) {
	env := newExportEnv(t)
	stubStill(t, env)
	if err := env.m.runRenderStill(context.Background(), env.job, env.id, StillRequest{AtMs: 0}); err != nil {
		t.Fatal(err)
	}
	if env.plan.Width != 1080 || env.plan.Height != 1920 {
		t.Errorf("size = %dx%d", env.plan.Width, env.plan.Height)
	}
}

func TestRunRenderStillRefusals(t *testing.T) {
	for _, at := range []int64{-1, 30_000, 99_999} {
		env := newExportEnv(t)
		stubStill(t, env)
		err := env.m.runRenderStill(context.Background(), env.job, env.id, StillRequest{AtMs: at})
		if err == nil || env.renders != 0 {
			t.Errorf("at %d: err = %v renders %d", at, err, env.renders)
		}
	}
	t.Run("render failure saves nothing", func(t *testing.T) {
		env := newExportEnv(t)
		env.renderErr = core.Errorf(core.CodeToolFailed, "the renderer failed")
		if err := env.m.runRenderStill(context.Background(), env.job, env.id, StillRequest{AtMs: 100}); err == nil || len(env.rec.outputs) != 0 {
			t.Fatalf("err = %v outputs %v", err, env.rec.outputs)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		env := newExportEnv(t)
		ctx, cancel := context.WithCancel(context.Background())
		exportRenderFn = func(ctx context.Context, _ *viz.RenderBroker, _ *core.JobContext, _ viz.RenderPlan) (viz.RenderOutput, error) {
			cancel()
			return viz.RenderOutput{}, ctx.Err()
		}
		if err := env.m.runRenderStill(ctx, env.job, env.id, StillRequest{AtMs: 100}); !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestValidateOptionsNewActions(t *testing.T) {
	env := newExportEnv(t)
	ok := []Options{
		{Action: ActionRenderAudio, ProjectID: env.id},
		{Action: ActionRenderStill, ProjectID: env.id, Still: &StillRequest{AtMs: 0}},
	}
	for _, o := range ok {
		if err := env.m.validateOptions(o); err != nil {
			t.Errorf("%s: %v", o.Action, err)
		}
	}
	bad := []Options{
		{Action: ActionRenderAudio},
		{Action: ActionRenderAudio, ProjectID: "nope"},
		{Action: ActionRenderStill, ProjectID: env.id},
		{Action: ActionRenderStill, ProjectID: env.id, Still: &StillRequest{AtMs: -5}},
		{Action: ActionRenderStill, Still: &StillRequest{AtMs: 5}},
	}
	for i, o := range bad {
		if err := env.m.validateOptions(o); err == nil {
			t.Errorf("bad case %d accepted", i)
		}
	}
}

func TestRunDispatchesTheNewActions(t *testing.T) {
	env := newExportEnv(t)
	calls := stubAudioEncode(t)
	env.job = newJob(t, env.dir, Options{Action: ActionRenderAudio, ProjectID: env.id}, env.rec, nil)
	if err := env.m.Run(context.Background(), env.job); err != nil || len(*calls) != 1 {
		t.Fatalf("render-audio: %v %d", err, len(*calls))
	}
	stubStill(t, env)
	env.rec = &recorder{}
	env.job = newJob(t, env.dir, Options{Action: ActionRenderStill, ProjectID: env.id, Still: &StillRequest{AtMs: 10}}, env.rec, nil)
	if err := env.m.Run(context.Background(), env.job); err != nil || env.plan == nil || env.plan.Still == nil {
		t.Fatalf("render-still: %v", err)
	}
}
