package grade

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
	"toolbox/modules/editstudio"
)

// stubStill replaces the broker: it records the plan and writes the file the host would.
func stubStill(t *testing.T, codec string) *[]viz.RenderPlan {
	t.Helper()
	var plans []viz.RenderPlan
	renderStillFn = func(_ context.Context, _ *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
		plans = append(plans, plan)
		p := filepath.Join(job.TempDir, "still."+codec)
		if err := os.WriteFile(p, []byte("pixels"), 0o644); err != nil {
			return viz.RenderOutput{}, err
		}
		name := codec
		if codec == "jpg" {
			name = "jpeg"
		}
		return viz.RenderOutput{Path: p, Codec: name, Frames: 1}, nil
	}
	copyMetaFn = func(context.Context, *core.JobContext, string, string) error { return nil }
	t.Cleanup(func() {
		renderStillFn = func(ctx context.Context, br *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
			return br.Render(ctx, job, plan)
		}
		copyMetaFn = copyMetadata
	})
	return &plans
}

func decodeDoc(t *testing.T, raw string) editstudio.EditProject {
	t.Helper()
	var doc editstudio.EditProject
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestPictureJobBuildsAStillPlanAndSavesTheFile(t *testing.T) {
	plans := stubStill(t, "jpg")
	edit := &fakeEdit{image: true}
	eng := &fakeEngine{}
	m := newModule(t, edit, eng)
	installDepth(t, m)
	in := writeJPEG(t, filepath.Join(t.TempDir(), "rain.jpg"), 201, 101)
	r := neonNoir()
	r.Ops = append(r.Ops, Op{ID: "dddddd", Kind: "depthfog", On: true, Amount: 0.5, Region: Region{Kind: "far", Split: 0.5}, Params: map[string]json.RawMessage{}})
	job, rec := newJob(t, []string{in}, Options{Recipe: r, Wild: 0.4, Format: "same"})
	if err := m.Validate(job.Inputs, job.Options); err != nil {
		t.Fatal(err)
	}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(*plans) != 1 {
		t.Fatalf("%d renders", len(*plans))
	}
	plan := (*plans)[0]
	if plan.Width != 200 || plan.Height != 100 { // sizes are even
		t.Errorf("size = %dx%d", plan.Width, plan.Height)
	}
	if plan.Still == nil || plan.Still.Format != "jpg" || plan.Still.Quality != 92 || plan.Still.AtMs != 0 {
		t.Errorf("still = %+v", plan.Still)
	}
	if plan.Grade == nil || plan.Grade.Wild != 0.4 || !strings.Contains(plan.Grade.RecipeJSON, `"name":"Neon Noir"`) {
		t.Errorf("grade = %+v", plan.Grade)
	}
	doc := decodeDoc(t, plan.Edit.ProjectJSON)
	if doc.Size == nil || doc.Size.W != 200 || doc.Size.H != 100 || len(doc.Tracks) != 1 || len(doc.Tracks[0].Clips) != 1 {
		t.Fatalf("doc = %+v", doc)
	}
	clip := doc.Tracks[0].Clips[0]
	if clip.Kind != "image" || clip.Matte == nil || clip.Matte.Mode != "image" || clip.Matte.ID != "subject" || clip.Depth == nil || clip.Depth.ID != "depth" {
		t.Errorf("clip = %+v", clip)
	}
	if !strings.HasSuffix(clip.Path, "source.jpg") {
		t.Errorf("the host should get the staged upright copy, got %q", clip.Path)
	}
	for _, key := range []string{"p:" + clip.Path, "m:subject", "d:depth"} {
		if plan.Edit.Images[key] == "" {
			t.Errorf("images lack %q: %v", key, plan.Edit.Images)
		}
	}
	// The same maps are listed as "a:<path>" for ClipAux.still.
	if plan.Edit.Images["a:"+plan.Edit.Images["m:subject"]] == "" || plan.Edit.Images["a:"+plan.Edit.Images["d:depth"]] == "" {
		t.Errorf("no a: aliases: %v", plan.Edit.Images)
	}

	want := filepath.Join(job.OutputDir, "rain (Neon Noir).jpg")
	if len(rec.outputs) != 1 || rec.outputs[0] != want {
		t.Errorf("outputs = %v, want %s", rec.outputs, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Error("the graded file isn't there")
	}
	if len(eng.calls) != 1 || len(edit.imageMattes) != 1 {
		t.Errorf("maps made: %v / %d mattes", eng.calls, len(edit.imageMattes))
	}
	if !strings.Contains(rec.title, "rain.jpg") {
		t.Errorf("title = %q", rec.title)
	}
}

func TestPictureJobSkipsMapsItDoesntNeed(t *testing.T) {
	plans := stubStill(t, "jpg")
	edit := &fakeEdit{image: true}
	eng := &fakeEngine{}
	m := newModule(t, edit, eng)
	in := writeJPEG(t, filepath.Join(t.TempDir(), "a.jpg"), 64, 64)
	// Neon Noir at Tasteful: the chaos edge glow is off and no op needs depth; the
	// background gradient map needs the subject only.
	job, _ := newJob(t, []string{in}, Options{Recipe: neonNoir(), Wild: 0.2, Format: "same"})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(eng.calls) != 0 || len(edit.imageMattes) != 1 {
		t.Errorf("calls %v, mattes %d", eng.calls, len(edit.imageMattes))
	}
	doc := decodeDoc(t, (*plans)[0].Edit.ProjectJSON)
	if doc.Tracks[0].Clips[0].Depth != nil {
		t.Error("the clip refers to a depth map nobody made")
	}

	// A look with no regions makes no maps at all, and needs no models.
	plain := Options{Recipe: DefaultOptions().Recipe, Wild: 0.5, Format: "same"}
	job2, _ := newJob(t, []string{in}, plain)
	m2 := newModule(t, nil, nil)
	if err := m2.Run(context.Background(), job2); err != nil {
		t.Fatalf("a plain look needs nothing: %v", err)
	}
}

func TestPictureJobFormats(t *testing.T) {
	for _, tc := range []struct {
		name, format, ext, wantFormat string
		quality                       int
	}{
		{"a.jpg", "same", ".jpg", "jpg", 92},
		{"a.jpeg", "same", ".jpg", "jpg", 92},
		{"a.png", "same", ".png", "png", 92},
		{"a.webp", "same", ".webp", "webp", 90},
		{"a.heic", "same", ".jpg", "jpg", 92}, // HEIC becomes JPEG
		{"a.tif", "same", ".jpg", "jpg", 92},
		{"a.jpg", "png", ".png", "png", 92},
		{"a.png", "webp", ".webp", "webp", 90},
	} {
		if got := pictureExt(tc.name, tc.format); got != tc.ext {
			t.Errorf("pictureExt(%s, %s) = %s, want %s", tc.name, tc.format, got, tc.ext)
		}
	}
	plans := stubStill(t, "png")
	m := newModule(t, nil, nil)
	in := writeJPEG(t, filepath.Join(t.TempDir(), "photo.jpg"), 64, 64)
	job, rec := newJob(t, []string{in}, Options{Recipe: DefaultOptions().Recipe, Wild: 0.5, Format: "png"})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if (*plans)[0].Still.Format != "png" || !strings.HasSuffix(rec.outputs[0], "photo (Clean).png") {
		t.Errorf("format %s, output %v", (*plans)[0].Still.Format, rec.outputs)
	}
}

func TestPictureJobNeverOverwrites(t *testing.T) {
	stubStill(t, "jpg")
	m := newModule(t, nil, nil)
	in := writeJPEG(t, filepath.Join(t.TempDir(), "a.jpg"), 64, 64)
	var outs []string
	for i := 0; i < 2; i++ {
		job, rec := newJob(t, []string{in}, Options{Recipe: DefaultOptions().Recipe, Wild: 0.5, Format: "same"})
		job.OutputDir = filepath.Join(t.TempDir(), "shared") // each job gets its own temp, one output dir below
		if i == 1 {
			job.OutputDir = filepath.Dir(outs[0])
		}
		if err := m.Run(context.Background(), job); err != nil {
			t.Fatal(err)
		}
		outs = append(outs, rec.outputs[0])
	}
	if outs[0] == outs[1] {
		t.Errorf("both jobs wrote %s", outs[0])
	}
}

func TestPictureJobErrors(t *testing.T) {
	m := newModule(t, &fakeEdit{}, &fakeEngine{})
	in := writeJPEG(t, filepath.Join(t.TempDir(), "a.jpg"), 64, 64)

	// A region's model is missing: the job refuses, naming the pack, before any rendering.
	rendered := false
	renderStillFn = func(context.Context, *viz.RenderBroker, *core.JobContext, viz.RenderPlan) (viz.RenderOutput, error) {
		rendered = true
		return viz.RenderOutput{}, nil
	}
	t.Cleanup(func() {
		renderStillFn = func(ctx context.Context, br *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
			return br.Render(ctx, job, plan)
		}
	})
	job, _ := newJob(t, []string{in}, Options{Recipe: neonNoir(), Wild: 0.5, Format: "same"})
	if ae := core.AsAppError(m.Run(context.Background(), job)); ae == nil || ae.Code != core.CodeDependencyMissing {
		t.Errorf("missing model: %v", ae)
	}
	if rendered {
		t.Error("rendered without the map")
	}

	// A render failure is the job's error; a cancel is reported as one.
	renderStillFn = func(context.Context, *viz.RenderBroker, *core.JobContext, viz.RenderPlan) (viz.RenderOutput, error) {
		return viz.RenderOutput{}, core.Errorf(core.CodeToolFailed, "The visual renderer failed")
	}
	plain := Options{Recipe: DefaultOptions().Recipe, Wild: 0.5, Format: "same"}
	job, rec := newJob(t, []string{in}, plain)
	if err := m.Run(context.Background(), job); core.AsAppError(err).Code != core.CodeToolFailed || len(rec.outputs) != 0 {
		t.Errorf("render failure: %v %v", err, rec.outputs)
	}
	ctx, cancel := context.WithCancel(context.Background())
	renderStillFn = func(ctx context.Context, _ *viz.RenderBroker, _ *core.JobContext, _ viz.RenderPlan) (viz.RenderOutput, error) {
		cancel()
		return viz.RenderOutput{}, context.Canceled
	}
	job, _ = newJob(t, []string{in}, plain)
	if err := m.Run(ctx, job); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: %v", err)
	}

	// No window: the job says so instead of waiting for the renderer's timeout.
	hostWaitFn = func(*viz.RenderBroker) error { return viz.ErrNoHost() }
	job, _ = newJob(t, []string{in}, plain)
	if err := m.Run(context.Background(), job); err == nil || !strings.Contains(err.Error(), "Open Toolbox") {
		t.Errorf("no host: %v", err)
	}
	hostWaitFn = func(*viz.RenderBroker) error { return nil }

	// A missing file, a tiny picture, and bad options.
	job, _ = newJob(t, []string{filepath.Join(t.TempDir(), "gone.jpg")}, plain)
	if ae := core.AsAppError(m.Run(context.Background(), job)); ae.Code != core.CodeNotFound {
		t.Errorf("missing file: %v", ae)
	}
	tiny := writeJPEG(t, filepath.Join(t.TempDir(), "t.jpg"), 30, 30)
	job, _ = newJob(t, []string{tiny}, plain)
	if ae := core.AsAppError(m.Run(context.Background(), job)); ae == nil || ae.Code != core.CodeValidation {
		t.Errorf("tiny picture: %v", ae)
	}
	if err := m.Validate([]string{in}, []byte(`{"wild":2,"format":"same","recipe":{"v":1,"name":"x","tier":"mine","wildCurve":"linear","ops":[]}}`)); core.AsAppError(err) == nil {
		t.Error("wildness 2 accepted")
	}
	if err := m.Validate([]string{in}, []byte(`{"wild":0.5,"format":"tiff"}`)); core.AsAppError(err) == nil {
		t.Error("format tiff accepted")
	}
	if err := m.Validate([]string{in}, []byte(`{"wild":0.5,"format":"same","surprise":1}`)); core.AsAppError(err) == nil {
		t.Error("an unknown option was accepted")
	}
	if err := m.Validate([]string{filepath.Join(t.TempDir(), "x.txt")}, []byte(`{}`)); core.AsAppError(err) == nil {
		t.Error("a text file was accepted")
	}
}

func TestPictureJobRunsTheVibeItWasGiven(t *testing.T) {
	stubStill(t, "jpg")
	f := &fakeText{replies: []string{goodLook}}
	m := newModule(t, nil, nil)
	m.cfg.Text = f
	in := writeJPEG(t, filepath.Join(t.TempDir(), "x.jpg"), 64, 64)
	job, rec := newJob(t, []string{in}, Options{Recipe: DefaultOptions().Recipe, Wild: 0.1, Format: "same", Vibe: "rain", VibeSeed: 5})
	// The grading ops of the model's look use maps; give the engine what they need.
	m.cfg.Edit = &fakeEdit{image: true}
	m.cfg.Caller = &fakeEngine{}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(f.reqs) != 1 || f.reqs[0].Seed != 5 || !strings.Contains(f.reqs[0].Prompt, "rain") {
		t.Errorf("vibe requests = %+v", f.reqs)
	}
	if !strings.HasSuffix(rec.outputs[0], "x (Wet Neon).jpg") {
		t.Errorf("output %v is named after the model's look", rec.outputs)
	}
}

func TestVideoJobRendersAnInMemoryEdit(t *testing.T) {
	edit := &fakeEdit{people: true}
	eng := &fakeEngine{}
	m := newModule(t, edit, eng)
	installDepth(t, m)
	mediaProbeFn = func(context.Context, string, string) (media.Info, error) {
		return media.Info{DurationMs: 8000, Video: &media.VideoStream{Width: 7680, Height: 4320, FPS: 23.976}}, nil
	}
	t.Cleanup(func() { mediaProbeFn = media.Probe })
	in := filepath.Join(t.TempDir(), "clip.mov")
	if err := writeFile(in, "x"); err != nil {
		t.Fatal(err)
	}
	r := neonNoir()
	r.Ops = append(r.Ops, Op{ID: "dddddd", Kind: "depthfog", On: true, Amount: 0.5, Region: Region{Kind: "far", Split: 0.5}, Params: map[string]json.RawMessage{}})
	job, rec := newJob(t, []string{in}, Options{Recipe: r, Wild: 1, Format: "jpg"}) // the format option is for pictures
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(edit.renders) != 1 {
		t.Fatalf("%d renders", len(edit.renders))
	}
	call := edit.renders[0]
	doc := decodeDoc(t, string(call.Doc))
	if doc.Size == nil || doc.Size.W != 3840 || doc.Size.H != 2160 || doc.FPS != 24 {
		t.Errorf("an 8K 23.976 fps source: size %+v fps %d", doc.Size, doc.FPS)
	}
	clip := doc.Tracks[0].Clips[0]
	if clip.Kind != "video" || clip.Path != in || clip.EndMs != 8000 || clip.Volume != 1 || clip.Matte == nil || clip.Matte.Mode != "people" || clip.Depth == nil {
		t.Errorf("clip = %+v", clip)
	}
	if call.Grade == nil || call.Grade.Wild != 1 || !strings.Contains(call.Grade.RecipeJSON, "Neon Noir") {
		t.Errorf("grade = %+v", call.Grade)
	}
	if call.Extra.Streams["m:subject"].Stream == "" || call.Extra.Streams["d:depth"].Stream == "" ||
		!strings.HasSuffix(call.Extra.Streams["d:depth"].Index, "depth-export.idx.json") {
		t.Errorf("extra = %+v", call.Extra)
	}
	want := filepath.Join(job.OutputDir, "clip (Neon Noir).mp4")
	if call.Out != want || len(rec.outputs) != 1 || rec.outputs[0] != want {
		t.Errorf("out %q, outputs %v", call.Out, rec.outputs)
	}
	if doc.AnalysisKey != "" {
		t.Error("beat sync was off")
	}
}

func TestVideoJobBeatSync(t *testing.T) {
	edit := &fakeEdit{}
	m := newModule(t, edit, nil)
	mediaProbeFn = func(context.Context, string, string) (media.Info, error) {
		return media.Info{DurationMs: 3000, Video: &media.VideoStream{Width: 1280, Height: 720, FPS: 30}}, nil
	}
	t.Cleanup(func() { mediaProbeFn = media.Probe })
	in := filepath.Join(t.TempDir(), "clip.mp4")
	if err := writeFile(in, "x"); err != nil {
		t.Fatal(err)
	}
	opts := Options{Recipe: DefaultOptions().Recipe, Wild: 0.5, Format: "same", Beat: Beat{On: true}}
	job, _ := newJob(t, []string{in}, opts)
	if err := m.Run(context.Background(), job); err == nil || !strings.Contains(err.Error(), "Beat sync") {
		t.Errorf("without an analyzer: %v", err)
	}
	if len(edit.renders) != 0 {
		t.Error("rendered without the analysis")
	}
}

func TestVideoJobErrors(t *testing.T) {
	m := newModule(t, &fakeEdit{}, &fakeEngine{})
	in := filepath.Join(t.TempDir(), "clip.mp4")
	if err := writeFile(in, "x"); err != nil {
		t.Fatal(err)
	}
	plain := Options{Recipe: DefaultOptions().Recipe, Wild: 0.5, Format: "same"}
	mediaProbeFn = func(context.Context, string, string) (media.Info, error) { return media.Info{}, nil }
	t.Cleanup(func() { mediaProbeFn = media.Probe })
	job, _ := newJob(t, []string{in}, plain)
	if ae := core.AsAppError(m.Run(context.Background(), job)); ae == nil || ae.Code != core.CodeValidation {
		t.Errorf("an audio-only file: %v", ae)
	}
	m.cfg.Edit = nil
	job, _ = newJob(t, []string{in}, plain)
	if err := m.Run(context.Background(), job); err == nil {
		t.Error("no exporter")
	}
}

func TestActiveRecipeDropsInactiveOps(t *testing.T) {
	r := neonNoir()
	r.Ops[0].On = false
	if got := activeRecipe(r, 0.5); len(got.Ops) != 1 || got.Ops[0].Kind != "gradmap" {
		t.Errorf("at 0.5: %+v", got.Ops)
	}
	if got := activeRecipe(r, 0.9); len(got.Ops) != 2 {
		t.Errorf("at 0.9: %+v", got.Ops)
	}
	if got := activeRecipe(r, ChaosAbove); len(got.Ops) != 1 {
		t.Error("chaos ops are active only above 0.66")
	}
}

func TestStagePictureAppliesOrientationAndCaps(t *testing.T) {
	dir := t.TempDir()
	in := writeJPEG(t, filepath.Join(dir, "a.jpg"), 120, 80)
	path, w, h, scaled, err := stagePicture(context.Background(), in, dir)
	if err != nil || w != 120 || h != 80 || scaled || !strings.HasSuffix(path, "source.jpg") {
		t.Fatalf("%q %dx%d %v %v", path, w, h, scaled, err)
	}
	if _, err := os.Stat(in); err != nil {
		t.Error("the input was touched")
	}
	odd := writeJPEG(t, filepath.Join(dir, "odd.jpg"), 101, 77)
	if _, w, h, _, err := stagePicture(context.Background(), odd, dir); err != nil || w != 100 || h != 76 {
		t.Errorf("odd = %dx%d, %v", w, h, err)
	}
	if _, _, _, _, err := stagePicture(context.Background(), filepath.Join(dir, "x.jpg"), dir); err == nil {
		t.Error("a missing picture was staged")
	}
}
