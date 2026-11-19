package editstudio

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/viz"
)

// gradeDoc is the one-clip edit Color Grader builds: a video with a people
// matte and a depth map, no song, sized by Size.
func gradeDoc(path string, w, h int) EditProject {
	doc := NewProject("16:9", 30, 1)
	doc.Song, doc.AnalysisKey, doc.Sources = nil, "", []Source{}
	doc.Size = &Size{W: w, H: h}
	doc.Tracks = []Track{{ID: "t1", Kind: "video", Name: "Video", Clips: []Clip{{
		ID: "c1", Kind: "video", Path: path, StartMs: 0, EndMs: 5000, Volume: 1, Fit: "fill", Blend: "normal", Slow: "blend", FxTarget: "clip",
		Matte: &Matte{Mode: MattePeople, ID: "subject", ToMs: 5000, Clicks: []MatteClick{}, Stroke: MatteStroke{Color: "#ffffff"}, Glow: MatteGlow{Color: "#ffffff"}},
		Depth: &DepthRef{ID: "depth", ToMs: 5000},
	}}}}
	return doc
}

func TestRenderEditExportsAnInMemoryEditWithoutAProject(t *testing.T) {
	env := newExportEnv(t)
	src := filepath.Join(env.dir, "clip.mov")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	doc := gradeDoc(src, 1920, 1080)
	raw, _ := json.Marshal(doc)
	grade := &viz.GradePlan{RecipeJSON: `{"v":1}`, Wild: 0.7}
	extra := &viz.EditPlan{
		Streams: map[string]viz.EditPlanStream{"m:subject": {Stream: "/c/s.h264", Index: "/c/s.idx.json"}, "d:depth": {Stream: "/c/d.h264", Index: "/c/d.idx.json"}},
		Images:  map[string]string{"x:y": "/c/y.png"},
	}
	out := filepath.Join(env.dir, "lib", "graded", "clip (Look).mp4")
	job := newJob(t, env.dir, Options{}, env.rec, map[string]string{"ffmpeg": "ffmpeg-bin", "ffprobe": "ffprobe-bin"})
	if err := env.m.RenderEdit(context.Background(), job, "clip.mov", raw, grade, out, extra); err != nil {
		t.Fatalf("RenderEdit: %v", err)
	}
	p := env.plan
	if p == nil || p.Width != 1920 || p.Height != 1080 || p.FPS != 30 || p.Grade != grade || p.Still != nil {
		t.Fatalf("plan = %+v", p)
	}
	if p.StartMs != 0 || p.EndMs != 5000 || p.Analysis.Key != "" {
		t.Errorf("range %d..%d analysis %q", p.StartMs, p.EndMs, p.Analysis.Key)
	}
	if st := p.Edit.Streams["v:"+src]; st.Stream != src+".h264" {
		t.Errorf("the source stream isn't prepared: %+v", p.Edit.Streams)
	}
	if p.Edit.Streams["m:subject"].Stream != "/c/s.h264" || p.Edit.Streams["d:depth"].Index != "/c/d.idx.json" || p.Edit.Images["x:y"] != "/c/y.png" {
		t.Errorf("the caller's files weren't added: %+v %+v", p.Edit.Streams, p.Edit.Images)
	}
	var back EditProject
	if err := json.Unmarshal([]byte(p.Edit.ProjectJSON), &back); err != nil {
		t.Fatal(err)
	}
	clip := back.Tracks[0].Clips[0]
	if clip.Matte == nil || clip.Matte.ID != "subject" || clip.Depth == nil || back.Size == nil || back.Size.W != 1920 {
		t.Errorf("the plan's project lost the matte, depth or size: %+v", back)
	}
	if b, err := os.ReadFile(out); err != nil || string(b) != "mp4" {
		t.Errorf("output %q: %v", b, err)
	}
	if len(env.rec.outputs) != 0 {
		t.Errorf("RenderEdit registered outputs %v; the caller does that", env.rec.outputs)
	}
	if env.mixes != 1 || env.muxes != 1 {
		t.Errorf("mixes %d muxes %d", env.mixes, env.muxes)
	}
}

func TestRenderEditErrors(t *testing.T) {
	env := newExportEnv(t)
	job := newJob(t, env.dir, Options{}, env.rec, map[string]string{"ffmpeg": "ffmpeg-bin", "ffprobe": "ffprobe-bin"})
	src := filepath.Join(env.dir, "clip.mov")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(env.dir, "o.mp4")
	ok, _ := json.Marshal(gradeDoc(src, 1280, 720))
	gone, _ := json.Marshal(gradeDoc(filepath.Join(env.dir, "gone.mov"), 1280, 720))

	if err := env.m.RenderEdit(context.Background(), job, "x", json.RawMessage(`{`), nil, out, nil); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeValidation {
		t.Errorf("damaged edit: %v", err)
	}
	if err := env.m.RenderEdit(context.Background(), job, "x", gone, nil, out, nil); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeNotFound {
		t.Errorf("missing source: %v", err)
	}
	env.renderErr = core.Errorf(core.CodeToolFailed, "The visual renderer failed")
	if err := env.m.RenderEdit(context.Background(), job, "x", ok, nil, out, nil); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeToolFailed {
		t.Errorf("render failure: %v", err)
	}
	if _, err := os.Stat(out); err == nil {
		t.Error("a failed render left a file")
	}
	env.renderErr = nil
	withKey := gradeDoc(src, 1280, 720)
	withKey.AnalysisKey = "nope-s0-none-m0"
	raw, _ := json.Marshal(withKey)
	if err := env.m.RenderEdit(context.Background(), job, "x", raw, nil, out, nil); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeValidation {
		t.Errorf("an analysis that isn't cached: %v", err)
	}
}

func TestMatteModelsPresentAndStreamIndex(t *testing.T) {
	m := newTestModule(t)
	if people, image := m.MatteModelsPresent(); people || image {
		t.Errorf("models present in an empty folder: %v %v", people, image)
	}
	called := ""
	old := writeIndexFn
	writeIndexFn = func(stream string, w, h, fps int) (StreamIndex, error) {
		called = stream
		return StreamIndex{}, nil
	}
	t.Cleanup(func() { writeIndexFn = old })
	if err := m.WriteStreamIndex("/x/depth-export.h264", 64, 36, 30); err != nil || called != "/x/depth-export.h264" {
		t.Errorf("WriteStreamIndex: %v %q", err, called)
	}
}
