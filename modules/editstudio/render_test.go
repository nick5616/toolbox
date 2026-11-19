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
	"time"

	"toolbox/core"
	"toolbox/core/viz"
	"toolbox/modules/videoeditor"
)

func TestExportSize(t *testing.T) {
	cases := []struct {
		aspect string
		short  int
		w, h   int
	}{
		{"9:16", 1080, 1080, 1920},
		{"9:16", 720, 720, 1280},
		{"9:16", 1440, 1440, 2560},
		{"4:5", 1080, 1080, 1350},
		{"4:5", 720, 720, 900},
		{"1:1", 1080, 1080, 1080},
		{"16:9", 1080, 1920, 1080},
		{"16:9", 720, 1280, 720},
		{"16:9", 1440, 2560, 1440},
	}
	for _, tc := range cases {
		if w, h := exportSize(tc.aspect, tc.short); w != tc.w || h != tc.h {
			t.Errorf("%s @%d = %dx%d, want %dx%d", tc.aspect, tc.short, w, h, tc.w, tc.h)
		}
	}
}

func TestInterpKeyOf(t *testing.T) {
	if got := interpKeyOf("/a.mov", 1500, 3200); got != "i:/a.mov|1-4" {
		t.Fatalf("key = %s", got)
	}
}

func TestCollectNeeds(t *testing.T) {
	doc := validDoc()
	doc.Song = &Song{Path: "/s.mp3", StartMs: 0, EndMs: 10_000}
	doc.Tracks = []Track{
		{ID: "t1", Kind: "video", Clips: []Clip{
			{ID: "a", Kind: "video", Path: "/v1.mov", StartMs: 0, EndMs: 2000, Matte: &Matte{ID: "m1"}},
			{ID: "b", Kind: "video", Path: "/v1.mov", StartMs: 2000, EndMs: 4000, InMs: 1500, Speed: "0.5", Slow: "interpolate"},
			{ID: "c", Kind: "image", Path: "/p.jpg", StartMs: 4000, EndMs: 5000, Matte: &Matte{ID: "m2"}},
			{ID: "d", Kind: "color", Color: "#000000", StartMs: 5000, EndMs: 6000},
			{ID: "e", Kind: "video", Path: "/late.mov", StartMs: 10_000, EndMs: 11_000},
			{ID: "f", Kind: "video", Path: "/fast.mov", StartMs: 6000, EndMs: 7000, Speed: "2", Slow: "interpolate"},
		}},
		{ID: "t2", Kind: "video", Muted: true, Clips: []Clip{{ID: "g", Kind: "video", Path: "/muted.mov", StartMs: 0, EndMs: 1000}}},
		{ID: "t3", Kind: "adjust", Clips: []Clip{{ID: "h", Kind: "adjust", StartMs: 0, EndMs: 1000}}},
	}
	n := collectNeeds(doc)
	if !slices.Equal(n.videos, []string{"/v1.mov", "/fast.mov"}) {
		t.Errorf("videos = %v", n.videos)
	}
	if !slices.Equal(n.images, []string{"/p.jpg"}) {
		t.Errorf("images = %v", n.images)
	}
	if !slices.Equal(n.mattes, []string{"m1", "m2"}) {
		t.Errorf("mattes = %v", n.mattes)
	}
	// Half speed over 2 s plays 1 s of source from 1.5 s: whole seconds 1..3.
	if len(n.interps) != 1 || n.interps[0].key != "i:/v1.mov|1-3" || n.interps[0].fromMs != 1500 || n.interps[0].toMs != 2500 {
		t.Errorf("interps = %+v", n.interps)
	}
}

// exportEnv is a module with a real Analyzer cache (so validateDoc passes),
// the files a validDoc points at, and the seams stubbed.
type exportEnv struct {
	m    *Module
	id   string
	doc  EditProject
	dir  string
	rec  *recorder
	job  *core.JobContext
	plan *viz.RenderPlan
	// counters
	streams, images, interps, renders, mixes, muxes int
	muxArgs                                         []string
	mux                                             muxSpec
	renderErr                                       error
}

func newExportEnv(t *testing.T) *exportEnv {
	t.Helper()
	dir := t.TempDir()
	write := func(name string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	song, a, b := write("song.mp3"), write("a.mov"), write("b.jpg")
	an := viz.NewAnalyzer(filepath.Join(dir, "an"), "", nil, nil)
	ref := viz.AnalysisRef{Key: "abc-s1-none-m0", AudioJSON: write("audio.json"), FeaturesPath: write("f.bin")}
	if err := an.WriteRef(ref); err != nil {
		t.Fatal(err)
	}
	store := &memStore{m: map[string]core.StoredProject{}}
	m := New(Config{Store: store, ProjectsDir: filepath.Join(dir, "projects"), Analyzer: an})

	doc := validDoc()
	doc.Song.Path = song
	doc.Sources = nil
	doc.Tracks[0].Clips[0].Path, doc.Tracks[0].Clips[0].Matte = a, nil
	doc.Tracks[0].Clips[1].Path = b
	doc.ExportHeight = 1080
	info, err := m.docs.Create(context.Background(), "My: Edit", doc)
	if err != nil {
		t.Fatal(err)
	}
	env := &exportEnv{m: m, id: info.ID, doc: doc, dir: dir, rec: &recorder{}}
	env.job = newJob(t, dir, Options{Action: ActionRender, ProjectID: info.ID}, env.rec, nil)

	restore := func(fn func()) { t.Cleanup(fn) }
	oRender, oMux, oProbe, oNow, oMix, oStream, oImage, oInterp := exportRenderFn, exportMuxFn, exportProbeFn, exportNowFn, exportMixFn, ensureStreamFn, ensureImageFn, ensureInterpFn
	restore(func() {
		exportRenderFn, exportMuxFn, exportProbeFn, exportNowFn, exportMixFn, ensureStreamFn, ensureImageFn, ensureInterpFn = oRender, oMux, oProbe, oNow, oMix, oStream, oImage, oInterp
	})

	exportProbeFn = func(_ context.Context, _ string, paths []string) []videoeditor.ClipInfo {
		var out []videoeditor.ClipInfo
		for _, p := range paths {
			out = append(out, videoeditor.ClipInfo{Path: p, Kind: "video", Width: 1080, Height: 1920, Rotation: 90, DurationMs: 9000, HasAudio: true})
		}
		return out
	}
	var shorts []int
	ensureStreamFn = func(_ *Module, _ context.Context, _ *core.JobContext, path string, short, fps int, on func(float64)) (EditStream, error) {
		env.streams++
		shorts = append(shorts, short)
		on(1)
		return EditStream{Stream: path + ".h264", Index: path + ".idx.json", FPS: fps}, nil
	}
	ensureImageFn = func(_ *Module, _ context.Context, _ *core.JobContext, path string, maxDim int) (string, error) {
		env.images++
		if maxDim != ExportImageMax {
			t.Errorf("image cap = %d", maxDim)
		}
		return path + ".edit.jpg", nil
	}
	ensureInterpFn = func(_ *Module, _ context.Context, _ *core.JobContext, path string, from, to int64, fps int, on func(float64)) (EditStream, EditStream, error) {
		env.interps++
		return EditStream{}, EditStream{Stream: path + ".interp.h264", Index: path + ".interp.idx.json"}, nil
	}
	exportRenderFn = func(_ context.Context, _ *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
		env.renders++
		env.plan = &plan
		if env.renderErr != nil {
			return viz.RenderOutput{}, env.renderErr
		}
		job.Progress(0.5, "frames")
		p := filepath.Join(job.TempDir, "render.h264")
		_ = os.WriteFile(p, []byte("h264"), 0o644)
		return viz.RenderOutput{Path: p, Codec: "h264", Frames: 900, Encoder: "h264-hw"}, nil
	}
	exportMixFn = func(_ *Module, _ context.Context, job *core.JobContext, _ EditProject, ffmpeg, dst string) error {
		env.mixes++
		if ffmpeg != "ffmpeg-bin" || filepath.Base(dst) != "mix.wav" || filepath.Dir(dst) != job.TempDir {
			t.Errorf("mix(%s, %s)", ffmpeg, dst)
		}
		return os.WriteFile(dst, []byte("wav"), 0o644)
	}
	exportMuxFn = func(_ context.Context, ffmpeg string, out viz.RenderOutput, audio string, s muxSpec, dst string, on func(float64)) error {
		env.muxes++
		env.mux = s
		env.muxArgs = []string{ffmpeg, out.Path, audio}
		if s.FPS != 30 || out.Frames != 900 || s.Reencode || s.AudioStartMs != 0 || s.AudioLenMs != 0 {
			t.Errorf("mux %+v frames %d", s, out.Frames)
		}
		on(1)
		return os.WriteFile(dst, []byte("mp4"), 0o644)
	}
	base := time.Unix(1000, 0)
	calls := 0
	exportNowFn = func() time.Time {
		calls++
		if calls == 1 {
			return base
		}
		return base.Add(10 * time.Second)
	}
	return env
}

func TestRunRenderFlow(t *testing.T) {
	env := newExportEnv(t)
	if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
		t.Fatalf("runRender: %v", err)
	}
	if env.streams != 1 || env.images != 1 || env.interps != 0 || env.renders != 1 || env.mixes != 1 || env.muxes != 1 {
		t.Fatalf("calls: streams %d images %d interps %d renders %d mixes %d muxes %d", env.streams, env.images, env.interps, env.renders, env.mixes, env.muxes)
	}
	p := env.plan
	if p.Width != 1080 || p.Height != 1920 || p.FPS != 30 || p.Mode != viz.ModeOpaque || p.StartMs != 10_000 || p.EndMs != 40_000 || p.Seed != env.doc.Seed {
		t.Errorf("plan = %+v", p)
	}
	if p.Analysis.Key != "abc-s1-none-m0" || p.ShowJSON != "" || p.Edit == nil {
		t.Errorf("plan analysis/edit: %+v", p)
	}
	a := env.doc.Tracks[0].Clips[0].Path
	if st, ok := p.Edit.Streams["v:"+a]; !ok || st.Stream != a+".h264" || st.Index != a+".idx.json" {
		t.Errorf("streams = %+v", p.Edit.Streams)
	}
	if got := p.Edit.Images["p:"+env.doc.Tracks[0].Clips[1].Path]; !strings.HasSuffix(got, "b.jpg.edit.jpg") {
		t.Errorf("images = %+v", p.Edit.Images)
	}
	var back EditProject
	if err := json.Unmarshal([]byte(p.Edit.ProjectJSON), &back); err != nil || back.Aspect != "9:16" || len(back.Tracks) != 2 {
		t.Errorf("project json: %v %+v", err, back)
	}

	if len(env.rec.outputs) != 1 {
		t.Fatalf("outputs = %v", env.rec.outputs)
	}
	out := env.rec.outputs[0]
	if filepath.Dir(out) != env.job.OutputDir || filepath.Base(out) != "My_ Edit.mp4" {
		t.Errorf("output = %s", out)
	}
	if b, _ := os.ReadFile(out); string(b) != "mp4" {
		t.Errorf("output content = %q", b)
	}
	if env.rec.title != "Exporting — My: Edit" {
		t.Errorf("title = %q", env.rec.title)
	}
	var res Result
	if err := json.Unmarshal(env.rec.result, &res); err != nil {
		t.Fatal(err)
	}
	if res.Action != ActionRender || res.Encoder != "h264-hw" || len(res.Outputs) != 1 || res.Outputs[0] != out || res.Speed != 3 {
		t.Errorf("result = %+v", res)
	}
	last := -1.0
	for _, pr := range env.rec.progress {
		if pr < 0 {
			continue
		}
		if pr+1e-9 < last {
			t.Errorf("progress went backwards: %v", env.rec.progress)
			break
		}
		last = pr
	}
	if last != 1 {
		t.Errorf("final progress = %v", last)
	}
}

func TestRunRenderSizeFollowsExportHeight(t *testing.T) {
	env := newExportEnv(t)
	env.doc.Aspect, env.doc.ExportHeight = "16:9", 720
	if _, err := env.m.docs.Save(context.Background(), env.id, "My Edit", env.doc); err != nil {
		t.Fatal(err)
	}
	if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
		t.Fatal(err)
	}
	if env.plan.Width != 1280 || env.plan.Height != 720 {
		t.Errorf("plan size = %dx%d", env.plan.Width, env.plan.Height)
	}
}

func TestRunRenderUniqueOutputName(t *testing.T) {
	env := newExportEnv(t)
	if err := os.WriteFile(filepath.Join(env.job.OutputDir, "My_ Edit.mp4"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
		t.Fatal(err)
	}
	if got := filepath.Base(env.rec.outputs[0]); got == "My_ Edit.mp4" {
		t.Errorf("overwrote an existing file: %s", got)
	}
	if b, _ := os.ReadFile(filepath.Join(env.job.OutputDir, "My_ Edit.mp4")); string(b) != "old" {
		t.Error("existing file modified")
	}
}

func TestRunRenderInterpolatesSlowClips(t *testing.T) {
	env := newExportEnv(t)
	env.doc.Tracks[0].Clips[0].Speed = "0.5"
	env.doc.Tracks[0].Clips[0].Slow = "interpolate"
	if _, err := env.m.docs.Save(context.Background(), env.id, "My Edit", env.doc); err != nil {
		t.Fatal(err)
	}
	if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
		t.Fatal(err)
	}
	a := env.doc.Tracks[0].Clips[0].Path
	key := "i:" + a + "|0-2" // clip 0 s..2 s at half speed from InMs 500: source 500..1500 ms
	if st, ok := env.plan.Edit.Streams[key]; !ok || st.Stream != a+".interp.h264" {
		t.Errorf("streams = %+v (want %s)", env.plan.Edit.Streams, key)
	}
}

func TestRunRenderUsesUprightSizeForTheStreamTier(t *testing.T) {
	env := newExportEnv(t)
	var got int
	ensureStreamFn = func(_ *Module, _ context.Context, _ *core.JobContext, path string, short, fps int, on func(float64)) (EditStream, error) {
		got = short
		return EditStream{Stream: "s", Index: "i"}, nil
	}
	if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
		t.Fatal(err)
	}
	// 1080x1920 rotated 90 is 1920x1080 upright; the 1080x1920 output.
	if want := ExportShort(1920, 1080, 1080, 1920); got != want {
		t.Errorf("short = %d, want %d", got, want)
	}
}

func TestRunRenderRejectsAnInvalidProject(t *testing.T) {
	env := newExportEnv(t)
	env.doc.Song.Path = filepath.Join(env.dir, "gone.mp3")
	if _, err := env.m.docs.Save(context.Background(), env.id, "My Edit", env.doc); err != nil {
		t.Fatal(err)
	}
	err := env.m.runRender(context.Background(), env.job, env.id)
	var ae *core.AppError
	if !errors.As(err, &ae) {
		t.Fatalf("err = %v", err)
	}
	if env.renders != 0 || len(env.rec.outputs) != 0 {
		t.Error("rendered an invalid project")
	}
}

func TestRunRenderUnreadableSource(t *testing.T) {
	env := newExportEnv(t)
	exportProbeFn = func(_ context.Context, _ string, paths []string) []videoeditor.ClipInfo {
		return []videoeditor.ClipInfo{{Path: paths[0], Error: "Couldn't read this file"}}
	}
	err := env.m.runRender(context.Background(), env.job, env.id)
	if err == nil || !strings.Contains(err.Error(), "a.mov") {
		t.Fatalf("err = %v", err)
	}
	if env.renders != 0 {
		t.Error("rendered with an unreadable source")
	}
}

func TestRunRenderMatteNotReady(t *testing.T) {
	env := newExportEnv(t)
	// ensureExportFiles asks the matte state; with no files the matte isn't ready.
	doc := env.doc
	doc.Tracks[0].Clips[0].Matte = &Matte{Mode: "people", ID: "m9"}
	_, _, err := env.m.ensureExportFiles(context.Background(), env.job, env.id, doc, "ffprobe-bin", 1080, 1920)
	if err == nil {
		t.Fatal("expected an error for a matte with no files")
	}
}

func TestRunRenderFailureAndCancel(t *testing.T) {
	t.Run("render error", func(t *testing.T) {
		env := newExportEnv(t)
		env.renderErr = core.Errorf(core.CodeToolFailed, "the renderer failed")
		err := env.m.runRender(context.Background(), env.job, env.id)
		if err == nil || env.mixes != 0 || env.muxes != 0 || len(env.rec.outputs) != 0 {
			t.Fatalf("err = %v mixes %d muxes %d outputs %v", err, env.mixes, env.muxes, env.rec.outputs)
		}
	})
	t.Run("cancel during the render", func(t *testing.T) {
		env := newExportEnv(t)
		ctx, cancel := context.WithCancel(context.Background())
		exportRenderFn = func(ctx context.Context, _ *viz.RenderBroker, _ *core.JobContext, _ viz.RenderPlan) (viz.RenderOutput, error) {
			cancel()
			return viz.RenderOutput{}, ctx.Err()
		}
		err := env.m.runRender(ctx, env.job, env.id)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
		if len(env.rec.outputs) != 0 || env.mixes != 0 {
			t.Error("kept going after cancel")
		}
	})
	t.Run("cancel during the mux leaves nothing in the library", func(t *testing.T) {
		env := newExportEnv(t)
		ctx, cancel := context.WithCancel(context.Background())
		exportMuxFn = func(ctx context.Context, _ string, _ viz.RenderOutput, _ string, _ muxSpec, dst string, _ func(float64)) error {
			_ = os.WriteFile(dst, []byte("partial"), 0o644)
			cancel()
			return ctx.Err()
		}
		err := env.m.runRender(ctx, env.job, env.id)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
		entries, _ := os.ReadDir(env.job.OutputDir)
		if len(entries) != 0 || len(env.rec.outputs) != 0 {
			t.Errorf("library has %d files, outputs %v", len(entries), env.rec.outputs)
		}
		if _, err := os.Stat(filepath.Join(env.job.TempDir, "edit.mp4")); err == nil {
			t.Error("partial mux left behind")
		}
	})
	t.Run("cancel while preparing sources", func(t *testing.T) {
		env := newExportEnv(t)
		ctx, cancel := context.WithCancel(context.Background())
		ensureStreamFn = func(_ *Module, ctx context.Context, _ *core.JobContext, _ string, _, _ int, _ func(float64)) (EditStream, error) {
			cancel()
			return EditStream{}, ctx.Err()
		}
		err := env.m.runRender(ctx, env.job, env.id)
		if !errors.Is(err, context.Canceled) || env.renders != 0 {
			t.Fatalf("err = %v renders %d", err, env.renders)
		}
	})
}
