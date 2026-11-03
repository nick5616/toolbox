package editstudio

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

// fakeEngine answers engine calls by method, records them and can write the file a handler would.
type fakeEngine struct {
	mu     sync.Mutex
	calls  []fakeCall
	reply  map[string]string
	events map[string][]sidecar.Event
	err    map[string]error
}

type fakeCall struct {
	Method string
	Params map[string]any
}

func (f *fakeEngine) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	b, _ := json.Marshal(params)
	var p map[string]any
	_ = json.Unmarshal(b, &p)
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{method, p})
	f.mu.Unlock()
	if err := f.err[method]; err != nil {
		return nil, err
	}
	if out, ok := p["outPath"].(string); ok {
		_ = os.WriteFile(out, []byte("matte-bytes"), 0o644)
	}
	for _, ev := range f.events[method] {
		onEvent(ev)
	}
	r, ok := f.reply[method]
	if !ok {
		r = `{}`
	}
	return json.RawMessage(r), nil
}

func (f *fakeEngine) last(method string) (fakeCall, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].Method == method {
			return f.calls[i], true
		}
	}
	return fakeCall{}, false
}

type matteEnv struct {
	m   *Module
	eng *fakeEngine
	pid string
	dir string
	rec *recorder
	job *core.JobContext
}

// newMatteEnv makes a module with a project, installed models and the seams replaced by fakes.
func newMatteEnv(t *testing.T, o MatteRequest) *matteEnv {
	t.Helper()
	m := newTestModule(t)
	eng := &fakeEngine{reply: map[string]string{}, events: map[string][]sidecar.Event{}, err: map[string]error{}}
	m.cfg.Engine = eng
	info, err := m.docs.Create(context.Background(), "Test", validDoc())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range matteModelPins {
		if err := os.MkdirAll(m.matteModelDir(), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(m.matteModelDir(), p.File), []byte("m"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	oldProbe, oldEnsure, oldIdx, oldPrev := probeFn, ensureStream, writeIndexFn, previewCopyFn
	t.Cleanup(func() { probeFn, ensureStream, writeIndexFn, previewCopyFn = oldProbe, oldEnsure, oldIdx, oldPrev })
	probeFn = func(context.Context, string, string) (media.Info, error) {
		return media.Info{DurationMs: 20_000, Video: &media.VideoStream{Width: 2160, Height: 3840}}, nil
	}
	ensureStream = func(_ *Module, _ context.Context, _ *core.JobContext, path string, short, fps int, on func(float64)) (EditStream, error) {
		on(1)
		return EditStream{Stream: path + ".edit.h264", Index: path + ".edit.idx.json", Width: 1080, Height: 1920, FPS: fps, Frames: 600}, nil
	}
	writeIndexFn = func(stream string, w, h, fps int) (StreamIndex, error) {
		idx := StreamIndex{Version: 1, Width: w, Height: h, FPS: fps, Frames: 100, Offsets: []int64{0, 1}, Keys: []int{0}}
		b, _ := json.Marshal(idx)
		return idx, os.WriteFile(IndexPath(stream), b, 0o644)
	}
	previewCopyFn = func(_ context.Context, _, src, dst string, w, h, pw, ph, fps int) error {
		return copyFile(src, dst)
	}
	rec := &recorder{}
	job := newJob(t, t.TempDir(), Options{Action: ActionMatte, ProjectID: info.ID, Matte: &o}, rec, nil)
	return &matteEnv{m: m, eng: eng, pid: info.ID, dir: m.mattesDir(info.ID), rec: rec, job: job}
}

func peopleReq() MatteRequest {
	return MatteRequest{ClipID: "c1", MatteID: "m1", Mode: MattePeople, Path: "/clips/a.mov", FromMs: 2000, ToMs: 6000}
}

func TestOutputSize(t *testing.T) {
	for _, c := range []struct {
		aspect string
		short  int
		w, h   int
	}{
		{"9:16", 1080, 1080, 1920}, {"9:16", 720, 720, 1280}, {"4:5", 1080, 1080, 1350}, {"16:9", 1080, 1920, 1080},
		{"16:9", 720, 1280, 720}, {"1:1", 1440, 1440, 1440}, {"9:16", 1440, 1440, 2560},
	} {
		if w, h := outputSize(c.aspect, c.short); w != c.w || h != c.h {
			t.Errorf("%s@%d = %dx%d, want %dx%d", c.aspect, c.short, w, h, c.w, c.h)
		}
	}
}

func TestMatteSize(t *testing.T) {
	for _, c := range []struct{ w, h, limit, ww, hh int }{
		{1080, 1920, 1080, 1080, 1920}, {1440, 2560, 1080, 1080, 1920}, {2160, 3840, 1080, 1080, 1920},
		{1920, 1080, 540, 960, 540}, {1080, 1920, 540, 540, 960}, {400, 300, 540, 400, 300}, {1440, 1440, 1080, 1080, 1080},
	} {
		if w, h := matteSize(c.w, c.h, c.limit); w != c.ww || h != c.hh {
			t.Errorf("matteSize(%d,%d,%d) = %dx%d, want %dx%d", c.w, c.h, c.limit, w, h, c.ww, c.hh)
		}
	}
}

func TestPadRangeAndFrames(t *testing.T) {
	for _, c := range []struct{ from, to, dur, f, t int64 }{
		{2000, 6000, 20_000, 1500, 6500}, {100, 6000, 20_000, 0, 6500}, {2000, 19_800, 20_000, 1500, 20_000}, {2000, 6000, 0, 1500, 6500},
	} {
		f, to := padRange(c.from, c.to, c.dur)
		if f != c.f || to != c.t {
			t.Errorf("padRange(%d,%d,%d) = %d,%d want %d,%d", c.from, c.to, c.dur, f, to, c.f, c.t)
		}
	}
	if frameOf(1500, 30) != 45 || frameOf(1517, 30) != 46 || frameOf(1000, 60) != 60 {
		t.Error("frameOf")
	}
}

func TestMaxSpeed(t *testing.T) {
	for _, c := range []struct {
		in   string
		want float64
	}{
		{"", 1}, {"  ", 1}, {`{"base":0.5}`, 0.5}, {`{"base":2}`, 2}, {`{"base":1,"keys":[{"t":0,"v":0.5},{"t":1000,"v":3,"ease":"ease"}]}`, 3},
		{`{"base":1,"keys":[{"t":0,"v":0.5}]}`, 0.5}, {"garbage", 1}, {`{}`, 1},
	} {
		if got := maxSpeed(c.in); got != c.want {
			t.Errorf("maxSpeed(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	from, to := clipSourceSpan(Clip{InMs: 500, StartMs: 1000, EndMs: 3000, Speed: `{"base":2}`})
	if from != 500 || to != 4500 {
		t.Errorf("span = %d..%d", from, to)
	}
}

func TestEngineClicks(t *testing.T) {
	cs, err := engineClicks([]MatteClick{{Ms: 3000, X: 0.5, Y: 0.25, Positive: true}, {Ms: 9999, X: 1, Y: 1}}, 2000, 10_000, 30, 45, 300, 1080, 1920)
	if err != nil {
		t.Fatal(err)
	}
	if cs[0]["frame"] != 90 || cs[0]["x"] != 540.0 || cs[0]["y"] != 480.0 || cs[0]["positive"] != true {
		t.Errorf("click 0 = %v", cs[0])
	}
	if _, err := engineClicks([]MatteClick{{Ms: 20_000, X: 0.5, Y: 0.5, Positive: true}}, 2000, 10_000, 30, 45, 300, 1080, 1920); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("a click outside the range: %v", err)
	}
	// a click in the padding clamps to the first frame
	cs, _ = engineClicks([]MatteClick{{Ms: 1700, X: 0, Y: 0, Positive: true}}, 2000, 10_000, 30, 51, 300, 10, 10)
	if cs[0]["frame"] != 51 {
		t.Errorf("clamped frame = %v", cs[0]["frame"])
	}
}

func TestRunPeopleMatte(t *testing.T) {
	e := newMatteEnv(t, peopleReq())
	e.eng.events["matte.people"] = []sidecar.Event{{Kind: "progress", Pct: 0.5, Msg: "Frame 1 of 2"}, {Kind: "log", Line: "hello", Level: "info"}}
	if err := e.m.runMatte(context.Background(), e.job, e.pid, peopleReq()); err != nil {
		t.Fatal(err)
	}
	call, ok := e.eng.last("matte.people")
	if !ok {
		t.Fatal("matte.people not called")
	}
	p := call.Params
	if p["fromFrame"] != 45.0 || p["toFrame"] != 196.0 { // 1500 ms .. 6500 ms at 30 fps, last frame inclusive
		t.Errorf("frames = %v..%v", p["fromFrame"], p["toFrame"])
	}
	if p["width"] != 1080.0 || p["height"] != 1920.0 || p["fps"] != 30.0 {
		t.Errorf("size/fps = %v %v %v", p["width"], p["height"], p["fps"])
	}
	if !strings.HasSuffix(p["outPath"].(string), "m1-export.h264") || p["modelDir"] != e.m.matteModelDir() {
		t.Errorf("paths = %v %v", p["outPath"], p["modelDir"])
	}
	if mdl := p["model"].(map[string]any); mdl["file"] != "rvm_mobilenetv3_fp32.onnx" || mdl["url"] != nil {
		t.Errorf("model = %v", mdl)
	}
	if len(e.rec.outputs) != 0 {
		t.Errorf("matte files are project data, not Library outputs: %v", e.rec.outputs)
	}
	var res Result
	if err := json.Unmarshal(e.rec.result, &res); err != nil {
		t.Fatal(err)
	}
	st := res.Matte
	if st == nil || !st.Ready || st.FromMs != 1500 || st.ToMs != 6500 || st.Export == nil || st.Preview == nil {
		t.Fatalf("state = %+v", st)
	}
	if !strings.HasSuffix(st.Preview.Stream, "m1-preview.h264") || st.Export.Width != 1080 {
		t.Errorf("streams = %+v %+v", st.Export, st.Preview)
	}
	// progress stays inside 0..1 and ends at 1; the engine's 50 % lands inside 5..90 %
	last := e.rec.progress[len(e.rec.progress)-1]
	if last != 1 {
		t.Errorf("last progress = %v", last)
	}
	found := false
	for _, p := range e.rec.progress {
		if p > 0.47 && p < 0.48 {
			found = true
		}
	}
	if !found {
		t.Errorf("engine progress not mapped into 5-90 %%: %v", e.rec.progress)
	}
	if len(e.rec.logs) != 1 {
		t.Errorf("logs = %v", e.rec.logs)
	}
}

func TestRunSelectMatteSendsPixelClicks(t *testing.T) {
	req := peopleReq()
	req.Mode = MatteSelect
	req.Clicks = []MatteClick{{Ms: 3000, X: 0.5, Y: 0.5, Positive: true}, {Ms: 4000, X: 0.1, Y: 0.9}}
	e := newMatteEnv(t, req)
	if err := e.m.runMatte(context.Background(), e.job, e.pid, req); err != nil {
		t.Fatal(err)
	}
	call, ok := e.eng.last("matte.select")
	if !ok {
		t.Fatal("matte.select not called")
	}
	cl := call.Params["clicks"].([]any)
	c0 := cl[0].(map[string]any)
	c1 := cl[1].(map[string]any)
	if c0["frame"] != 90.0 || c0["x"] != 540.0 || c0["y"] != 960.0 || c0["positive"] != true {
		t.Errorf("click 0 = %v", c0)
	}
	if c1["frame"] != 120.0 || c1["positive"] != false {
		t.Errorf("click 1 = %v", c1)
	}
	if call.Params["model"].(map[string]any)["file"] != "sam2.1_hiera_tiny.pt" {
		t.Errorf("model = %v", call.Params["model"])
	}
}

func TestRunSelectPreview(t *testing.T) {
	req := peopleReq()
	req.Mode, req.Preview = MatteSelect, true
	req.Clicks = []MatteClick{{Ms: 3000, X: 0.5, Y: 0.5, Positive: true}, {Ms: 3000, X: 0.2, Y: 0.2}, {Ms: 5000, X: 0.9, Y: 0.9, Positive: true}}
	e := newMatteEnv(t, req)
	if err := e.m.runMatte(context.Background(), e.job, e.pid, req); err != nil {
		t.Fatal(err)
	}
	call, ok := e.eng.last("matte.select_preview")
	if !ok {
		t.Fatal("matte.select_preview not called")
	}
	if call.Params["fromFrame"] != 90.0 || len(call.Params["clicks"].([]any)) != 2 {
		t.Errorf("params = %v", call.Params)
	}
	var res Result
	if err := json.Unmarshal(e.rec.result, &res); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(res.TryPath, "m1-try.png") || res.Matte != nil {
		t.Errorf("result = %+v", res)
	}
	if _, err := os.Stat(res.TryPath); err != nil {
		t.Errorf("the engine wrote the try PNG: %v", err)
	}
}

func TestRunImageMatte(t *testing.T) {
	req := MatteRequest{ClipID: "c2", MatteID: "ph1", Mode: MatteImage, Path: "/clips/b.jpg"}
	e := newMatteEnv(t, req)
	bg := filepath.Join(e.m.cfg.ModelsDir, "bg")
	if err := os.MkdirAll(bg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := e.m.requireMatteModel(MatteImage); !core.IsCode(err, core.CodeDependencyMissing) || !strings.Contains(core.AsAppError(err).Hint, "Image tool pack") {
		t.Fatalf("missing image model: %v", err)
	}
	if e.m.matteModels().Image {
		t.Error("Image should be false without the model")
	}
	e.eng.reply["bgremove.run"] = `{"output":"` + strings.ReplaceAll(filepath.ToSlash(filepath.Join(e.job.TempDir, "ph1 (mask).png")), `\`, `/`) + `"}`
	if err := os.WriteFile(filepath.Join(e.job.TempDir, "ph1 (mask).png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	spec := matteModelPinsBG(t)
	if err := os.WriteFile(filepath.Join(bg, spec), []byte("m"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := e.m.runMatte(context.Background(), e.job, e.pid, req); err != nil {
		t.Fatal(err)
	}
	call, _ := e.eng.last("bgremove.run")
	if call.Params["output"] != "mask" || call.Params["baseName"] != "ph1" || call.Params["input"] != "/clips/b.jpg" {
		t.Errorf("params = %v", call.Params)
	}
	if !fileExists(filepath.Join(e.dir, "ph1.png")) {
		t.Error("ph1.png not written")
	}
	var res Result
	_ = json.Unmarshal(e.rec.result, &res)
	if res.Matte == nil || !res.Matte.Ready || !strings.HasSuffix(res.Matte.Image, "ph1.png") {
		t.Errorf("state = %+v", res.Matte)
	}
	ok, err := e.m.matteReady(e.pid, Clip{Kind: "image", Matte: &Matte{Mode: MatteImage, ID: "ph1"}}, 30)
	if err != nil || !ok {
		t.Errorf("image matte ready = %v %v", ok, err)
	}
}

func matteModelPinsBG(t *testing.T) string {
	t.Helper()
	spec, ok := bgSpec()
	if !ok {
		t.Fatal("no balanced preset")
	}
	return spec
}

func TestRunMatteMissingPieces(t *testing.T) {
	req := peopleReq()
	e := newMatteEnv(t, req)
	if err := e.m.RemoveModel(PresetPeople); err != nil {
		t.Fatal(err)
	}
	err := e.m.runMatte(context.Background(), e.job, e.pid, req)
	if !core.IsCode(err, core.CodeDependencyMissing) || core.AsAppError(err).Hint != "Install the Music edits tool pack in Settings" {
		t.Errorf("missing people model: %v", err)
	}
	if len(e.eng.calls) != 0 {
		t.Error("the engine must not be called without a model")
	}

	e = newMatteEnv(t, req)
	e.eng.err["matte.people"] = core.Errorf(core.CodeToolFailed, "boom")
	if err := e.m.runMatte(context.Background(), e.job, e.pid, req); !core.IsCode(err, core.CodeToolFailed) {
		t.Errorf("engine error: %v", err)
	}
	if fileExists(filepath.Join(e.dir, "m1.json")) {
		t.Error("a failed job leaves no meta file (the matte isn't ready)")
	}

	e = newMatteEnv(t, req)
	e.m.cfg.Engine = nil
	if err := e.m.runMatte(context.Background(), e.job, e.pid, req); err == nil {
		t.Error("no engine should fail")
	}
}

func TestMatteSlotQueues(t *testing.T) {
	req := peopleReq()
	e := newMatteEnv(t, req)
	e.m.matteSem <- struct{}{} // another matte is running
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- e.m.runMatte(ctx, e.job, e.pid, req) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-done; err == nil {
		t.Error("a queued matte job should end when cancelled")
	}
	if len(e.eng.calls) != 0 {
		t.Error("a queued job must not run")
	}
}

// writeMatte makes the files of a finished video matte covering [from, to].
func writeMatte(t *testing.T, m *Module, pid, id string, from, to int64) {
	t.Helper()
	dir := m.mattesDir(pid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"export", "preview"} {
		stream := filepath.Join(dir, id+"-"+k+".h264")
		if err := os.WriteFile(stream, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(StreamIndex{Version: 1, Width: 540, Height: 960, FPS: 30, Frames: 10, Offsets: []int64{0, 1}, Keys: []int{0}})
		if err := os.WriteFile(IndexPath(stream), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeJSON(filepath.Join(dir, id+".json"), matteMeta{Mode: MattePeople, FromMs: from, ToMs: to, Width: 540, Height: 960, FPS: 30}); err != nil {
		t.Fatal(err)
	}
}

func TestMatteStatesAndReady(t *testing.T) {
	m := newTestModule(t)
	info, _ := m.docs.Create(context.Background(), "T", validDoc())
	pid := info.ID
	writeMatte(t, m, pid, "m1", 1000, 7000)

	sts, err := m.matteStates(pid, []string{"m1", "nope", "../evil", ""})
	if err != nil || len(sts) != 4 {
		t.Fatal(sts, err)
	}
	if !sts[0].Ready || sts[0].FromMs != 1000 || sts[0].ToMs != 7000 || sts[0].Export == nil || sts[0].Export.Frames != 10 || sts[0].Preview == nil {
		t.Errorf("m1 = %+v", sts[0])
	}
	for _, s := range sts[1:] {
		if s.Ready || s.Export != nil {
			t.Errorf("%q should be empty: %+v", s.ID, s)
		}
	}

	clip := func(in, start, end int64, speed string) Clip {
		return Clip{ID: "c", Kind: "video", Path: "/a.mov", StartMs: start, EndMs: end, InMs: in, Speed: speed, Matte: &Matte{Mode: MattePeople, ID: "m1"}}
	}
	for _, c := range []struct {
		name string
		clip Clip
		want bool
	}{
		{"inside", clip(2000, 0, 3000, ""), true},
		{"exactly the range", clip(1000, 0, 6000, ""), true},
		{"starts early", clip(900, 0, 1000, ""), false},
		{"ends late", clip(2000, 0, 5100, ""), false},
		{"a frame of rounding is fine", clip(2000, 0, 5020, ""), true},
		{"fast speed reaches further", clip(2000, 0, 2500, `{"base":2}`), true},
		{"fast speed too far", clip(2000, 0, 3000, `{"base":4}`), false},
		{"slow speed fits", clip(2000, 0, 8000, `{"base":0.5}`), true},
		{"curve uses its maximum", clip(2000, 0, 3000, `{"base":1,"keys":[{"t":0,"v":1},{"t":500,"v":3}]}`), false},
		{"no matte id", Clip{Matte: &Matte{}}, false},
		{"no matte", Clip{}, false},
		{"unknown matte", Clip{Matte: &Matte{ID: "zzz"}, InMs: 2000, EndMs: 3000}, false},
	} {
		ok, err := m.matteReady(pid, c.clip, 30)
		if err != nil || ok != c.want {
			t.Errorf("%s: ready = %v (%v), want %v", c.name, ok, err, c.want)
		}
	}
	// a half-made matte (preview copy missing) is not ready
	if err := os.Remove(filepath.Join(m.mattesDir(pid), "m1-preview.h264")); err != nil {
		t.Fatal(err)
	}
	if ok, _ := m.matteReady(pid, clip(2000, 0, 3000, ""), 30); ok {
		t.Error("missing preview copy must not be ready")
	}
}

func TestMatteIDsInJobs(t *testing.T) {
	mk := func(o Options) core.Job {
		b, _ := json.Marshal(o)
		return core.Job{OptionsJSON: string(b)}
	}
	got := matteIDsInJobs("p1", []core.Job{
		mk(Options{Action: ActionMatte, ProjectID: "p1", Matte: &MatteRequest{MatteID: "a"}}),
		mk(Options{Action: ActionMatte, ProjectID: "p2", Matte: &MatteRequest{MatteID: "b"}}),
		mk(Options{Action: ActionRender, ProjectID: "p1"}),
		{OptionsJSON: "garbage"},
	})
	if len(got) != 1 || !got["a"] {
		t.Errorf("ids = %v", got)
	}
}

func TestPruneMattes(t *testing.T) {
	m := newTestModule(t)
	info, _ := m.docs.Create(context.Background(), "T", validDoc())
	pid := info.ID
	for _, id := range []string{"keep", "drop"} {
		writeMatte(t, m, pid, id, 0, 5000)
	}
	dir := m.mattesDir(pid)
	for _, f := range []string{"keep.png", "drop.png", "drop-try.png", "drop-export.h264.part", "old-try.png", "fresh-try.png", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-3 * time.Hour)
	for _, f := range []string{"drop-try.png", "old-try.png"} {
		if err := os.Chtimes(filepath.Join(dir, f), past, past); err != nil {
			t.Fatal(err)
		}
	}
	doc := validDoc()
	doc.Tracks[0].Clips[0].Matte = &Matte{Mode: MattePeople, ID: "keep"}
	m.pruneMattes(pid, doc)

	want := map[string]bool{
		"keep-export.h264": true, "keep-export.idx.json": true, "keep-preview.h264": true, "keep.json": true, "keep.png": true,
		"keep-preview.idx.json": true, "fresh-try.png": true, "notes.txt": true, // fresh preview PNGs and unknown files stay
	}
	entries, _ := os.ReadDir(dir)
	got := map[string]bool{}
	for _, e := range entries {
		got[e.Name()] = true
	}
	for n := range want {
		if !got[n] {
			t.Errorf("%s was deleted", n)
		}
	}
	for n := range got {
		if !want[n] {
			t.Errorf("%s should be deleted", n)
		}
	}
	// a project with no mattes folder is fine
	m.pruneMattes("nothing", doc)
}

func TestMakePreviewCopy(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "export.h264")
	gen := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=720x1280:r=30:d=1", "-pix_fmt", "yuv420p",
		"-c:v", "libx264", "-g", "10", "-bf", "0", "-x264-params", "aud=1:repeat-headers=1", "-f", "h264", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generating: %v %s", err, out)
	}
	dst := filepath.Join(dir, "preview.h264")
	if err := makePreviewCopy(context.Background(), ffmpeg, src, dst, 720, 1280, 540, 960, 30); err != nil {
		t.Fatal(err)
	}
	b, err := exec.Command(ffprobe, "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", dst).Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(b)); got != "540,960,30" {
		t.Errorf("preview = %q, want 540,960,30", got)
	}
	if fileExists(dst + ".part") {
		t.Error(".part left behind")
	}
	// same size: a plain copy
	cp := filepath.Join(dir, "same.h264")
	if err := makePreviewCopy(context.Background(), ffmpeg, src, cp, 720, 1280, 720, 1280, 30); err != nil || !fileExists(cp) {
		t.Errorf("copy: %v", err)
	}
}
