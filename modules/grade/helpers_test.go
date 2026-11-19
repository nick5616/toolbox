package grade

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// -- job recorder ---------------------------------------------------------------------------

type recorder struct {
	mu       sync.Mutex
	outputs  []string
	logs     []string
	progress []float64
	title    string
	result   json.RawMessage
}

func newJob(t *testing.T, inputs []string, opts any) (*core.JobContext, *recorder) {
	t.Helper()
	raw, err := json.Marshal(opts)
	if err != nil {
		t.Fatal(err)
	}
	rec := &recorder{}
	dir := t.TempDir()
	job := core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Inputs: inputs, Options: raw,
		OutputDir: filepath.Join(dir, "out"), TempDir: filepath.Join(dir, "tmp"),
	}, core.JobHooks{
		Progress: func(p float64, _ string) { rec.mu.Lock(); rec.progress = append(rec.progress, p); rec.mu.Unlock() },
		Log:      func(_ core.LogStream, l string) { rec.mu.Lock(); rec.logs = append(rec.logs, l); rec.mu.Unlock() },
		Title:    func(s string) { rec.title = s },
		Output: func(p string) (core.Output, error) {
			rec.mu.Lock()
			rec.outputs = append(rec.outputs, p)
			rec.mu.Unlock()
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) { return filepath.Join(dir, "bin", id), nil },
		Result: func(r json.RawMessage) {
			rec.result = r
		},
	})
	for _, d := range []string{job.OutputDir, job.TempDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return job, rec
}

// -- fakes ----------------------------------------------------------------------------------

// fakeText is a TextGenerator (and VisionGenerator) replying from a list.
type fakeText struct {
	mu       sync.Mutex
	replies  []string
	reqs     []core.CompletionRequest
	readyErr error
	err      error
}

func (f *fakeText) Ready() (string, error)  { return "fake", f.readyErr }
func (f *fakeText) Vision() (string, error) { return "fake-vision", f.readyErr }
func (f *fakeText) ContextTokens() int      { return 4096 }
func (f *fakeText) Complete(ctx context.Context, req core.CompletionRequest) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if f.err != nil {
		return "", f.err
	}
	if len(f.reqs) > len(f.replies) {
		return f.replies[len(f.replies)-1], nil
	}
	return f.replies[len(f.reqs)-1], nil
}

// fakeEngine is a sidecar.Caller whose handlers write the files the real ones do.
type fakeEngine struct {
	mu    sync.Mutex
	calls []string
	args  map[string]map[string]any
}

func (e *fakeEngine) Call(_ context.Context, method string, params any, _ func(sidecar.Event)) (json.RawMessage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, method)
	if e.args == nil {
		e.args = map[string]map[string]any{}
	}
	p, _ := params.(map[string]any)
	e.args[method] = p
	switch method {
	case "depth.image":
		if err := writeGray16(p["out"].(string)); err != nil {
			return nil, err
		}
		return json.RawMessage(`{"width":8,"height":8}`), nil
	case "depth.video":
		dir, name := p["outDir"].(string), p["name"].(string)
		exp, prev := filepath.Join(dir, name+"-export.h264"), filepath.Join(dir, name+"-preview.h264")
		for _, f := range []string{exp, prev} {
			if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
				return nil, err
			}
		}
		return json.Marshal(map[string]any{"frames": 10, "exportPath": exp, "previewPath": prev, "width": 64, "height": 36, "previewWidth": 32, "previewHeight": 18})
	}
	return nil, core.Errorf(core.CodeInternal, "unexpected call %s", method)
}

func writeGray16(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	img := image.NewGray16(image.Rect(0, 0, 8, 8))
	for i := range img.Pix {
		img.Pix[i] = byte(i * 3)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

// fakeEdit is the EditRenderer.
type fakeEdit struct {
	mu            sync.Mutex
	people, image bool
	renders       []renderCall
	imageMattes   []string
	videoMattes   []string
	indexed       []string
	prepared      []int
}

type renderCall struct {
	Name  string
	Doc   json.RawMessage
	Grade *viz.GradePlan
	Out   string
	Extra *viz.EditPlan
}

func (f *fakeEdit) RenderEdit(_ context.Context, _ *core.JobContext, name string, doc json.RawMessage, g *viz.GradePlan, out string, extra *viz.EditPlan) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renders = append(f.renders, renderCall{name, doc, g, out, extra})
	return os.WriteFile(out, []byte("mp4"), 0o644)
}

func (f *fakeEdit) RunMatte(_ context.Context, _ *core.JobContext, path, dir, name string, _, _ int64, _, _ int) (viz.EditPlanStream, viz.EditPlanStream, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.videoMattes = append(f.videoMattes, path)
	exp, prev := filepath.Join(dir, name+"-export.h264"), filepath.Join(dir, name+"-preview.h264")
	for _, p := range []string{exp, prev} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			return viz.EditPlanStream{}, viz.EditPlanStream{}, err
		}
		if err := os.WriteFile(p[:len(p)-len(".h264")]+".idx.json", []byte("{}"), 0o644); err != nil {
			return viz.EditPlanStream{}, viz.EditPlanStream{}, err
		}
	}
	return viz.EditPlanStream{Stream: exp}, viz.EditPlanStream{Stream: prev}, nil
}

func (f *fakeEdit) RunImageMatte(_ context.Context, _ *core.JobContext, path, dst string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.imageMattes = append(f.imageMattes, path)
	return writeGray16(dst)
}

func (f *fakeEdit) PrepareStream(_ context.Context, _ *core.JobContext, path string, short, _ int, _ func(float64)) (string, string, int, int, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prepared = append(f.prepared, short)
	return path + ".h264", path + ".idx.json", 960, 540, 10, nil
}

func (f *fakeEdit) WriteStreamIndex(stream string, _, _, _ int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.indexed = append(f.indexed, stream)
	return os.WriteFile(stream[:len(stream)-len(".h264")]+".idx.json", []byte("{}"), 0o644)
}

func (f *fakeEdit) MatteModelsPresent() (bool, bool) { return f.people, f.image }

var _ EditRenderer = (*fakeEdit)(nil)

// -- files ----------------------------------------------------------------------------------

func writeJPEG(t *testing.T, path string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 255 / w), uint8(y * 255 / h), 90, 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

func neonNoir() Recipe {
	return Recipe{V: 1, Name: "Neon Noir", Tier: TierBonkers, Seed: 3, WildCurve: "late", Ops: []Op{
		{ID: "aaaaaa", Kind: "balance", On: true, Amount: 0.6, Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{"contrast": json.RawMessage("1.2")}},
		{ID: "bbbbbb", Kind: "gradmap", On: true, Amount: 0.8, Region: Region{Kind: "background", Feather: 0.2}, Params: map[string]json.RawMessage{}},
		{ID: "cccccc", Kind: "edgeglow", On: true, Chaos: true, Amount: 1, Region: Region{Kind: "all"}, Params: map[string]json.RawMessage{}},
	}}
}

func newModule(t *testing.T, edit EditRenderer, eng sidecar.Caller) *Module {
	t.Helper()
	dir := t.TempDir()
	hostWaitFn = func(*viz.RenderBroker) error { return nil }
	t.Cleanup(func() { hostWaitFn = func(br *viz.RenderBroker) error { return br.WaitForHost() } })
	return New(Config{
		Caller: eng, Edit: edit, CacheDir: filepath.Join(dir, "cache"), ModelsDir: filepath.Join(dir, "models"),
		LooksFile: filepath.Join(dir, "support", "grade", "looks.json"), LibraryDir: func() string { return filepath.Join(dir, "library") },
	})
}
