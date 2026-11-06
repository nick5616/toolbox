package paint

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/core/store"
)

func pngURL(t *testing.T, w, h int) string {
	t.Helper()
	im := image.NewNRGBA(image.Rect(0, 0, w, h))
	im.Set(0, 0, color.NRGBA{255, 0, 0, 255})
	var b bytes.Buffer
	if err := png.Encode(&b, im); err != nil {
		t.Fatal(err)
	}
	return dataURLPrefix + base64.StdEncoding.EncodeToString(b.Bytes())
}

func fillReq(t *testing.T) AIRequest {
	return AIRequest{Op: OpFill, Source: pngURL(t, 64, 48), Mask: pngURL(t, 64, 48), Model: "fast", Passes: 3, Ghost: 0.2, Drift: 0.5}
}

func TestNormalizeAI(t *testing.T) {
	src := pngURL(t, 64, 48)
	pt := AIPoint{X: 10, Y: 10, Positive: true}
	cases := []struct {
		name   string
		mutate func(*AIRequest)
		field  string // "" = valid
	}{
		{"fill ok", func(r *AIRequest) {}, ""},
		{"fill default model", func(r *AIRequest) { r.Model = "" }, ""},
		{"unknown op", func(r *AIRequest) { r.Op = "paint" }, "op"},
		{"source not a data url", func(r *AIRequest) { r.Source = "hello" }, "source"},
		{"source not png", func(r *AIRequest) { r.Source = dataURLPrefix + base64.StdEncoding.EncodeToString([]byte("nope")) }, "source"},
		{"source bad base64", func(r *AIRequest) { r.Source = dataURLPrefix + "!!!" }, "source"},
		{"source too big", func(r *AIRequest) { r.Source = dataURLPrefix + strings.Repeat("A", MaxAICropBytes*2) }, "source"},
		{"mask missing", func(r *AIRequest) { r.Mask = "" }, "mask"},
		{"mask size differs", func(r *AIRequest) { r.Mask = pngURL(t, 32, 48) }, "mask"},
		{"bad model", func(r *AIRequest) { r.Model = "huge" }, "model"},
		{"passes 0", func(r *AIRequest) { r.Passes = 0 }, "passes"},
		{"passes 13", func(r *AIRequest) { r.Passes = 13 }, "passes"},
		{"passes 12", func(r *AIRequest) { r.Passes = 12 }, ""},
		{"ghost range", func(r *AIRequest) { r.Ghost = 1.1 }, "ghost"},
		{"drift range", func(r *AIRequest) { r.Drift = -0.1 }, "drift"},
		{"direction", func(r *AIRequest) { r.DriftDir = "diagonal" }, "driftDir"},
		{"melt down", func(r *AIRequest) { r.DriftDir = "down" }, ""},
		{"offset range", func(r *AIRequest) { r.Offset = [2]int{MaxSide + 1, 0} }, "offset"},
		{"cutout ok", func(r *AIRequest) { *r = AIRequest{Op: OpCutout, Source: src, Model: "best"} }, ""},
		{"cutout mask", func(r *AIRequest) { *r = AIRequest{Op: OpCutout, Source: src, Mask: src} }, "mask"},
		{"cutout model", func(r *AIRequest) { *r = AIRequest{Op: OpCutout, Source: src, Model: "x"} }, "model"},
		{"segment ok", func(r *AIRequest) { *r = AIRequest{Op: OpSegment, Source: src, Points: []AIPoint{pt}} }, ""},
		{"segment no points", func(r *AIRequest) { *r = AIRequest{Op: OpSegment, Source: src} }, "points"},
		{"segment 65 points", func(r *AIRequest) {
			*r = AIRequest{Op: OpSegment, Source: src, Points: make([]AIPoint, 65)}
			for i := range r.Points {
				r.Points[i] = pt
			}
		}, "points"},
		{"segment outside", func(r *AIRequest) {
			*r = AIRequest{Op: OpSegment, Source: src, Points: []AIPoint{{X: 70, Y: 1, Positive: true}}}
		}, "points"},
		{"segment only negative", func(r *AIRequest) {
			*r = AIRequest{Op: OpSegment, Source: src, Points: []AIPoint{{X: 1, Y: 1}}}
		}, "points"},
		{"enhance ok", func(r *AIRequest) { *r = AIRequest{Op: OpEnhance, Source: src, Scale: 4} }, ""},
		{"enhance scale", func(r *AIRequest) { *r = AIRequest{Op: OpEnhance, Source: src, Scale: 3} }, "scale"},
		{"enhance anime preset", func(r *AIRequest) { *r = AIRequest{Op: OpEnhance, Source: src, Scale: 2, Model: "illustration"} }, "model"},
		{"enhance too large", func(r *AIRequest) { *r = AIRequest{Op: OpEnhance, Source: pngURL(t, 2000, 1000), Scale: 2} }, "source"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := fillReq(t)
			c.mutate(&req)
			got, crops, err := normalizeAI(req)
			if c.field == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if got.Source != "" || got.Mask != "" || len(crops.source) == 0 {
					t.Fatalf("images must move to the crops: %+v", got)
				}
				if got.Op == OpFill && got.Model == "" {
					t.Fatal("model default not applied")
				}
				return
			}
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
				t.Fatalf("want a validation error, got %v", err)
			}
			if _, ok := ae.Fields[c.field]; !ok {
				t.Fatalf("error fields %v lack %q", ae.Fields, c.field)
			}
		})
	}
}

// ---- fakes ----

type fakeEngine struct {
	method string
	params map[string]any
	events []sidecar.Event
	write  func(params map[string]any)
	result string
	err    error
}

func (f *fakeEngine) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.method = method
	f.params, _ = params.(map[string]any)
	for _, ev := range f.events {
		if onEvent != nil {
			onEvent(ev)
		}
	}
	if f.write != nil {
		f.write(f.params)
	}
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.result), nil
}

type fakeModels struct {
	inpaint, cutout, segment, enhance bool
	asked                             []string
}

func (f *fakeModels) Inpaint(m string) (json.RawMessage, bool) {
	f.asked = append(f.asked, "inpaint:"+m)
	return json.RawMessage(`{"model":"` + m + `","modelPath":"/m/` + m + `.onnx"}`), f.inpaint
}
func (f *fakeModels) Cutout(m string) (json.RawMessage, bool) {
	f.asked = append(f.asked, "cutout:"+m)
	return json.RawMessage(`{"model":{"file":"bg.onnx","kind":"birefnet"},"modelDir":"/m/bg"}`), f.cutout
}
func (f *fakeModels) Segment() (json.RawMessage, bool) {
	return json.RawMessage(`{"modelPath":"/m/sam.pt"}`), f.segment
}
func (f *fakeModels) Enhance(p string) (json.RawMessage, bool) {
	f.asked = append(f.asked, "enhance:"+p)
	return json.RawMessage(`{"model":{"file":"RealESRGAN_x4plus.pth"},"modelDir":"/m/up"}`), f.enhance
}

type recorder struct {
	progress []string
	result   json.RawMessage
	toolErr  error
}

func (r *recorder) hooks() core.JobHooks {
	return core.JobHooks{
		Progress: func(_ float64, m string) { r.progress = append(r.progress, m) },
		Log:      func(core.LogStream, string) {},
		Tool:     func(string) (string, error) { return "/engine", r.toolErr },
		Result:   func(b json.RawMessage) { r.result = b },
	}
}

func newAI(t *testing.T, eng *fakeEngine, models *fakeModels) (*Module, *AIModule) {
	t.Helper()
	m := New(Config{TmpDir: t.TempDir(), Engine: eng, Models: models,
		Resolve: func(string) (string, error) { return "/engine", nil }})
	return m, &AIModule{m: m}
}

// jobFor parks the request's crops the way submitAI does and returns a job context for Run.
func jobFor(t *testing.T, m *Module, rec *recorder, id string, req AIRequest) *core.JobContext {
	t.Helper()
	clean, crops, err := normalizeAI(req)
	if err != nil {
		t.Fatal(err)
	}
	o := aiOptions{Token: newToken(), ProjectID: "p1", Req: clean}
	m.ai().park(o.Token, crops)
	opts, _ := json.Marshal(o)
	if len(opts) > 4096 {
		t.Fatalf("options are %d bytes; they must stay small", len(opts))
	}
	return core.NewJobContext(core.JobContext{ID: id, ModuleID: AIModuleID, Options: opts, Attempt: 1, TempDir: t.TempDir()}, rec.hooks())
}

func TestRunFillPassesParamsAndResult(t *testing.T) {
	var written []string
	eng := &fakeEngine{
		events: []sidecar.Event{{Kind: "progress", Pct: 0.5, Msg: "Pass 1 of 3"}, {Kind: "log", Line: "hi"}},
		result: `{"output":"x","passes":3}`,
	}
	m, a := newAI(t, eng, &fakeModels{inpaint: true})
	eng.write = func(p map[string]any) {
		for _, k := range []string{"src", "mask"} {
			if _, err := os.Stat(p[k].(string)); err != nil {
				t.Errorf("%s not written before the call: %v", k, err)
			}
		}
		img := image.NewNRGBA(image.Rect(0, 0, 64, 48))
		var b bytes.Buffer
		_ = png.Encode(&b, img)
		dir := filepath.Dir(p["out"].(string))
		for _, n := range []string{"out.png", "pass-1.png", "pass-2.png", "pass-3.png"} {
			_ = os.WriteFile(filepath.Join(dir, n), b.Bytes(), 0o600)
			written = append(written, n)
		}
	}
	rec := &recorder{}
	job := jobFor(t, m, rec, "job1", fillReq(t))
	if err := a.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if eng.method != "paint.fill" {
		t.Fatalf("method = %s", eng.method)
	}
	p := eng.params
	if p["model"] != "fast" || p["modelPath"] != "/m/fast.onnx" || p["passes"] != 3 || p["ghost"] != 0.2 || p["drift"] != 0.5 || p["seed"] != int64(0) {
		t.Fatalf("params = %v", p)
	}
	if off, _ := p["offset"].([]int); len(off) != 2 {
		t.Fatalf("offset = %v", p["offset"])
	}
	var info AIResultInfo
	if err := json.Unmarshal(rec.result, &info); err != nil {
		t.Fatal(err)
	}
	if info.Op != OpFill || info.Passes != 3 || info.Width != 64 || info.Height != 48 {
		t.Fatalf("result = %+v", info)
	}
	if len(rec.progress) < 2 || rec.progress[1] != "Pass 1 of 3" {
		t.Fatalf("progress = %v", rec.progress)
	}

	// Results are read by index, any number of times, and only for known indexes.
	for _, idx := range []int{0, 1, 3, 0} {
		u, err := m.aiResult("job1", idx)
		if err != nil || !strings.HasPrefix(u, dataURLPrefix) {
			t.Fatalf("aiResult(%d) = %.30q, %v", idx, u, err)
		}
	}
	if _, err := m.aiResult("job1", 4); err == nil {
		t.Fatal("pass 4 doesn't exist")
	}
	for _, bad := range []string{"", "../x", "a/b", "job2"} {
		if _, err := m.aiResult(bad, 0); err == nil {
			t.Fatalf("aiResult(%q) should fail", bad)
		}
	}
	if _, err := m.aiResult("job1", -1); err == nil {
		t.Fatal("negative index")
	}
}

func TestRunOtherOpsParams(t *testing.T) {
	src := pngURL(t, 64, 48)
	cases := []struct {
		req    AIRequest
		method string
		check  func(map[string]any) bool
	}{
		{AIRequest{Op: OpCutout, Source: src, Model: "best"}, "paint.cutout", func(p map[string]any) bool { return p["modelDir"] == "/m/bg" && p["mask"] == nil }},
		{AIRequest{Op: OpSegment, Source: src, Points: []AIPoint{{X: 5, Y: 6, Positive: true}}}, "paint.segment", func(p map[string]any) bool {
			pts, _ := p["points"].([]AIPoint)
			return p["modelPath"] == "/m/sam.pt" && len(pts) == 1 && pts[0].X == 5
		}},
		{AIRequest{Op: OpEnhance, Source: src, Scale: 2}, "paint.enhance", func(p map[string]any) bool { return p["scale"] == 2 && p["modelDir"] == "/m/up" }},
	}
	for _, c := range cases {
		eng := &fakeEngine{result: `{"output":"x","score":0.8}`}
		m, a := newAI(t, eng, &fakeModels{inpaint: true, cutout: true, segment: true, enhance: true})
		eng.write = func(p map[string]any) {
			var b bytes.Buffer
			_ = png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, 8, 4)))
			_ = os.WriteFile(p["out"].(string), b.Bytes(), 0o600)
		}
		rec := &recorder{}
		if err := a.Run(context.Background(), jobFor(t, m, rec, "j", c.req)); err != nil {
			t.Fatalf("%s: %v", c.method, err)
		}
		if eng.method != c.method || !c.check(eng.params) {
			t.Fatalf("%s: params %v", c.method, eng.params)
		}
		var info AIResultInfo
		_ = json.Unmarshal(rec.result, &info)
		if info.Width != 8 || info.Height != 4 || (c.req.Op == OpSegment && info.Score != 0.8) {
			t.Fatalf("%s: result %+v", c.method, info)
		}
	}
}

func TestRunMissingModelIsDependencyError(t *testing.T) {
	cases := map[AIOp]string{OpFill: "inpaint", OpCutout: "bg-default", OpSegment: "matte-select", OpEnhance: "upscaler"}
	for op, component := range cases {
		eng := &fakeEngine{result: `{}`}
		m, a := newAI(t, eng, &fakeModels{})
		req := AIRequest{Op: op, Source: pngURL(t, 8, 8), Mask: "", Model: "best", Passes: 1, Scale: 2, Points: []AIPoint{{X: 1, Y: 1, Positive: true}}}
		if op == OpFill {
			req.Mask = pngURL(t, 8, 8)
		}
		if op == OpEnhance {
			req.Model = ""
		}
		err := a.Run(context.Background(), jobFor(t, m, &recorder{}, "j", req))
		var ae *core.AppError
		if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing || ae.Fields["component"] != component {
			t.Fatalf("%s: err = %v", op, err)
		}
		if eng.method != "" {
			t.Fatalf("%s: the engine was called without a model", op)
		}
	}
}

func TestRunErrors(t *testing.T) {
	eng := &fakeEngine{err: errors.New("boom")}
	m, a := newAI(t, eng, &fakeModels{inpaint: true})
	if err := a.Run(context.Background(), jobFor(t, m, &recorder{}, "j", fillReq(t))); err == nil || err.Error() != "boom" {
		t.Fatalf("engine error: %v", err)
	}
	// Engine not installed.
	rec := &recorder{toolErr: core.ErrDependencyMissing(sidecar.DepID, "")}
	err := a.Run(context.Background(), jobFor(t, m, rec, "j2", fillReq(t)))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("engine missing: %v", err)
	}
	// A request whose crops are gone (after a restart) and have no files.
	opts, _ := json.Marshal(aiOptions{Token: "gone", Req: AIRequest{Op: OpFill}})
	job := core.NewJobContext(core.JobContext{ID: "j3", Options: opts}, (&recorder{}).hooks())
	if err := a.Run(context.Background(), job); err == nil {
		t.Fatal("expired request must fail")
	}
}

func TestRetryReusesFiles(t *testing.T) {
	eng := &fakeEngine{result: `{"output":"x","passes":1}`}
	m, a := newAI(t, eng, &fakeModels{inpaint: true})
	eng.write = func(p map[string]any) {
		var b bytes.Buffer
		_ = png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, 4, 4)))
		_ = os.WriteFile(p["out"].(string), b.Bytes(), 0o600)
	}
	job := jobFor(t, m, &recorder{}, "j", fillReq(t))
	if err := a.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if err := a.Run(context.Background(), job); err != nil { // same options, token already used
		t.Fatalf("retry: %v", err)
	}
}

func TestStatus(t *testing.T) {
	eng := &fakeEngine{}
	m, _ := newAI(t, eng, &fakeModels{inpaint: true, segment: true})
	st := m.aiStatus()
	if len(st) != 4 {
		t.Fatalf("status = %+v", st)
	}
	by := map[string]AIModelInfo{}
	for _, s := range st {
		by[s.Tool] = s
	}
	if !by["fill"].Ready || by["fill"].Reason != "" || by["fill"].ModelSize != 0 || len(by["fill"].Needs) != 0 {
		t.Fatalf("fill = %+v", by["fill"])
	}
	cut := by["cutout"]
	if cut.Ready || len(cut.Needs) != 1 || cut.Needs[0] != "bg-default" || cut.Reason == "" || cut.ModelSize <= 0 {
		t.Fatalf("cutout = %+v", cut)
	}
	enh := by["enhance"]
	if enh.Ready || enh.Needs[0] != "upscaler" || enh.ModelSize != 67_040_989 {
		t.Fatalf("enhance = %+v", enh)
	}

	// No engine: every tool needs it first.
	m.cfg.Resolve = func(string) (string, error) { return "", errors.New("no") }
	for _, s := range m.aiStatus() {
		if s.Ready || len(s.Needs) == 0 || s.Needs[0] != "engine" {
			t.Fatalf("no engine: %+v", s)
		}
	}
	// No resolver at all.
	m.cfg.Models = nil
	for _, s := range m.aiStatus() {
		if s.Ready {
			t.Fatalf("no models: %+v", s)
		}
	}
}

func TestWarm(t *testing.T) {
	eng := &fakeEngine{result: `{}`}
	m, _ := newAI(t, eng, &fakeModels{inpaint: true})
	if err := m.warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	if eng.method != "paint.warm" || eng.params["modelPath"] == nil {
		t.Fatalf("warm call: %s %v", eng.method, eng.params)
	}
	// Errors are not fatal; a missing model or engine does nothing.
	eng2 := &fakeEngine{err: errors.New("boom")}
	m2, _ := newAI(t, eng2, &fakeModels{inpaint: true})
	if err := m2.warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	eng3 := &fakeEngine{}
	m3, _ := newAI(t, eng3, &fakeModels{})
	_ = m3.warm(context.Background())
	m3.cfg.Models = &fakeModels{inpaint: true}
	m3.cfg.Resolve = func(string) (string, error) { return "", errors.New("no") }
	_ = m3.warm(context.Background())
	if eng3.method != "" {
		t.Fatalf("warm called the engine: %s", eng3.method)
	}
}

func TestQuietDescriptor(t *testing.T) {
	d := (&AIModule{}).Descriptor()
	if d.ID != AIModuleID || !d.Quiet || !d.Hidden || !d.NotAStep || d.OutputSubdir != "" || d.MaxConcurrent != 1 {
		t.Fatalf("descriptor = %+v", d)
	}
}

func TestPruneTmp(t *testing.T) {
	m, _ := newAI(t, &fakeEngine{}, &fakeModels{})
	dir := filepath.Join(m.aiRoot(), "old")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	m.PruneTmp()
	if _, err := os.Stat(m.aiRoot()); !os.IsNotExist(err) {
		t.Fatal("tmp/paint not removed")
	}
	// pruneOld keeps recent job dirs and drops stale ones.
	fresh, stale := filepath.Join(m.aiRoot(), "fresh"), filepath.Join(m.aiRoot(), "stale")
	for _, d := range []string{fresh, stale} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * aiKeep)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	m.pruneOld()
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh dir pruned")
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale dir kept")
	}
}

func TestValidateOptions(t *testing.T) {
	a := &AIModule{}
	ok, _ := json.Marshal(aiOptions{Token: "t", Req: AIRequest{Op: OpCutout}})
	if err := a.Validate(nil, ok); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{}`, `{"token":"t","req":{"op":"x"}}`, `{"token":"t","extra":1,"req":{"op":"fill"}}`, `nope`} {
		if err := a.Validate(nil, json.RawMessage(bad)); err == nil {
			t.Fatalf("%s should be refused", bad)
		}
	}
}

// TestSubmitEndToEnd runs the real job manager with a fake engine: the crops
// reach the engine as files, the result is readable by index, and a failed job
// removes its directory.
func TestSubmitEndToEnd(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tmp := filepath.Join(dir, "tmp")
	eng := &fakeEngine{result: `{"output":"x","passes":2}`}
	eng.write = func(p map[string]any) {
		var b bytes.Buffer
		_ = png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, 64, 48)))
		d := filepath.Dir(p["out"].(string))
		for _, n := range []string{"out.png", "pass-1.png", "pass-2.png"} {
			_ = os.WriteFile(filepath.Join(d, n), b.Bytes(), 0o600)
		}
	}
	reg := core.NewRegistry()
	jobs := core.NewJobs(db, db, reg, core.NopEmitter{}, func(string) (string, error) { return "/engine", nil },
		func() core.Settings { return core.Settings{Concurrency: 2, LibraryDir: filepath.Join(dir, "lib")} }, tmp)
	m := New(Config{TmpDir: tmp, Engine: eng, Models: &fakeModels{inpaint: true}, Jobs: jobs, Store: db,
		Resolve: func(string) (string, error) { return "/engine", nil }})
	if err := reg.Register(&AIModule{m: m}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}

	job, err := m.submitAI(jobs, "p1", fillReq(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(job.OptionsJSON) > 4096 || strings.Contains(job.OptionsJSON, "base64") {
		t.Fatalf("persisted options must not carry images (%d bytes)", len(job.OptionsJSON))
	}
	final := waitJob(t, jobs, job.ID)
	if final.Status != core.JobDone || !final.Quiet {
		t.Fatalf("job = %+v", final)
	}
	var info AIResultInfo
	if err := json.Unmarshal([]byte(final.ResultJSON), &info); err != nil || info.Passes != 2 {
		t.Fatalf("result = %q, %v", final.ResultJSON, err)
	}
	if _, err := m.aiResult(job.ID, 2); err != nil {
		t.Fatal(err)
	}

	// A failing engine removes the job's files.
	eng.err = errors.New("boom")
	job2, err := m.submitAI(jobs, "p1", fillReq(t))
	if err != nil {
		t.Fatal(err)
	}
	if f := waitJob(t, jobs, job2.ID); f.Status != core.JobFailed {
		t.Fatalf("job2 = %+v", f)
	}
	d2, _ := m.aiDir(job2.ID)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(d2); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("failed job's folder not removed")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// An invalid request never reaches the manager.
	bad := fillReq(t)
	bad.Passes = 99
	if _, err := m.submitAI(jobs, "p1", bad); err == nil {
		t.Fatal("invalid request accepted")
	}
}

func waitJob(t *testing.T, jobs *core.Jobs, id string) core.Job {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		j, err := jobs.Get(context.Background(), id)
		if err == nil && j.Status.Finished() {
			return j
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return core.Job{}
}
