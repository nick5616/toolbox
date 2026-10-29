package redact

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/sidecar"
)

type call struct {
	method string
	params map[string]any
}

// fakeCaller answers by method and records every call.
type fakeCaller struct {
	calls  []call
	reply  map[string]string
	events map[string][]sidecar.Event
	err    error
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	raw, _ := json.Marshal(params)
	var p map[string]any
	_ = json.Unmarshal(raw, &p)
	f.calls = append(f.calls, call{method, p})
	for _, ev := range f.events[method] {
		onEvent(ev)
	}
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.reply[method]), nil
}

type rec struct {
	title    string
	progress []float64
	msgs     []string
	outputs  []string
	result   json.RawMessage
	tools    map[string]error
}

func (r *rec) hooks() core.JobHooks {
	return core.JobHooks{
		Progress: func(p float64, m string) { r.progress = append(r.progress, p); r.msgs = append(r.msgs, m) },
		Log:      func(core.LogStream, string) {},
		Title:    func(t string) { r.title = t },
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool:   func(id string) (string, error) { return "/bin/" + id, r.tools[id] },
		Result: func(b json.RawMessage) { r.result = b },
	}
}

type env struct {
	m      *Module
	fc     *fakeCaller
	models string
	cache  string
	dir    string
}

func newEnv(t *testing.T, withModels bool) *env {
	t.Helper()
	dir := t.TempDir()
	e := &env{fc: &fakeCaller{reply: map[string]string{}, events: map[string][]sidecar.Event{}}, models: filepath.Join(dir, "models"),
		cache: filepath.Join(dir, "cache", "redact"), dir: dir}
	e.m = &Module{sc: e.fc, modelsDir: e.models, cacheDir: e.cache}
	if withModels {
		for _, s := range models {
			if err := os.MkdirAll(e.m.modelDir(), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(e.m.modelPath(s), []byte("onnx"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return e
}

func (e *env) file(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(e.dir, "in", name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func (e *env) job(t *testing.T, r *rec, inputs []string, o Options) *core.JobContext {
	t.Helper()
	raw, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	out, tmp := filepath.Join(e.dir, "out"), filepath.Join(e.dir, "tmp")
	_ = os.MkdirAll(out, 0o755)
	_ = os.MkdirAll(tmp, 0o755)
	return core.NewJobContext(core.JobContext{ID: "job1", Inputs: inputs, Options: raw, OutputDir: out, TempDir: tmp}, r.hooks())
}

func opts(f func(*Options)) Options {
	o := DefaultOptions()
	if f != nil {
		f(&o)
	}
	return o
}

func mustJSON(t *testing.T, o Options) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func box(kind string) Box {
	return Box{ID: "b1", X: 0.1, Y: 0.1, W: 0.2, H: 0.2, Kind: kind, Enabled: true, Score: 0.9}
}

func TestValidate(t *testing.T) {
	e := newEnv(t, false)
	a, b := e.file(t, "a.jpg"), e.file(t, "b.PNG")
	v := e.file(t, "c.mp4")
	v2 := e.file(t, "d.mov")
	txt := e.file(t, "e.txt")
	det := filepath.Join(e.cache, "j.json")
	tests := []struct {
		name   string
		inputs []string
		o      Options
		want   string // substring of the message, "" = ok
	}{
		{"detect images", []string{a, b}, opts(nil), ""},
		{"detect video", []string{v}, opts(nil), ""},
		{"bad extension", []string{txt}, opts(nil), "txt"},
		{"mixed", []string{a, v}, opts(nil), "images and videos separately"},
		{"two videos", []string{v, v2}, opts(nil), "one video"},
		{"nothing to find", []string{a}, opts(func(o *Options) { o.Faces, o.Plates = false, false }), "invalid"},
		{"nothing to find is fine for apply", []string{a}, opts(func(o *Options) {
			o.Action, o.Faces, o.Plates = ActionApply, false, false
			o.ImageBoxes = map[string][]Box{a: nil}
		}), ""},
		{"bad style", []string{a}, opts(func(o *Options) { o.Style = "smudge" }), "invalid"},
		{"strength", []string{a}, opts(func(o *Options) { o.Strength = 11 }), "invalid"},
		{"padding", []string{a}, opts(func(o *Options) { o.Padding = 51 }), "invalid"},
		{"sensitivity", []string{a}, opts(func(o *Options) { o.Sensitivity = "paranoid" }), "invalid"},
		{"action", []string{a}, opts(func(o *Options) { o.Action = "explode" }), "invalid"},
		{"apply needs boxes", []string{a, b}, opts(func(o *Options) {
			o.Action = ActionApply
			o.ImageBoxes = map[string][]Box{a: {box("face")}}
		}), "needs its boxes"},
		{"apply with boxes", []string{a, b}, opts(func(o *Options) {
			o.Action = ActionApply
			o.ImageBoxes = map[string][]Box{a: {box("face")}, b: {}}
		}), ""},
		{"apply box size", []string{a}, opts(func(o *Options) {
			o.Action = ActionApply
			o.ImageBoxes = map[string][]Box{a: {{W: 0, H: 1}}}
		}), "invalid"},
		{"apply video needs cache path", []string{v}, opts(func(o *Options) { o.Action = ActionApply; o.DetectionsPath = filepath.Join(e.dir, "x.json") }), "detections"},
		{"apply video outside cache", []string{v}, opts(func(o *Options) { o.Action = ActionApply; o.DetectionsPath = filepath.Join(e.cache, "..", "x.json") }), "detections"},
		{"apply video not json", []string{v}, opts(func(o *Options) { o.Action = ActionApply; o.DetectionsPath = filepath.Join(e.cache, "x.bin") }), "detections"},
		{"apply video", []string{v}, opts(func(o *Options) { o.Action = ActionApply; o.DetectionsPath = det }), ""},
		{"manual box timing", []string{v}, opts(func(o *Options) {
			o.Action = ActionApply
			o.DetectionsPath = det
			o.ManualBoxes = []TimedBox{{Box: box("manual"), StartMs: 2000, EndMs: 1000}}
		}), "invalid"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := e.m.Validate(tt.inputs, mustJSON(t, tt.o))
			if tt.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation || !strings.Contains(strings.ToLower(ae.Message+" "+strings.Join(fieldVals(ae), " ")), strings.ToLower(tt.want)) {
				t.Fatalf("err = %v, want validation containing %q", err, tt.want)
			}
		})
	}
}

func fieldVals(e *core.AppError) []string {
	var out []string
	for _, v := range e.Fields {
		out = append(out, v)
	}
	return out
}

func TestOutputExt(t *testing.T) {
	for in, want := range map[string]string{"a.JPG": ".jpg", "a.jpeg": ".jpg", "a.png": ".png", "a.WEBP": ".webp", "a.tif": ".png", "a.TIFF": ".png", "a.heic": ".jpg", "a.heif": ".jpg", "a.bmp": ".bmp"} {
		if got := outputExt(in); got != want {
			t.Errorf("outputExt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDetectImagesCallsEngineOncePerImage(t *testing.T) {
	e := newEnv(t, true)
	a, b := e.file(t, "a.jpg"), e.file(t, "b.png")
	e.fc.reply["redact.detect_image"] = `{"width":100,"height":50,"boxes":[{"id":"f1","x":0.1,"y":0.2,"w":0.3,"h":0.4,"kind":"face","enabled":true,"score":0.9},{"id":"p1","x":0.5,"y":0.5,"w":0.2,"h":0.1,"kind":"plate","enabled":true,"score":0.8}]}`
	e.fc.events["redact.detect_image"] = []sidecar.Event{{Kind: "progress", Pct: 0.5, Msg: "Finding"}}
	r := &rec{}
	job := e.job(t, r, []string{a, b}, opts(func(o *Options) { o.Sensitivity = SensitivityHigh }))
	if err := e.m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(e.fc.calls) != 2 || e.fc.calls[0].method != "redact.detect_image" {
		t.Fatalf("calls = %+v", e.fc.calls)
	}
	p := e.fc.calls[1].params
	if p["path"] != b || p["sensitivity"] != "high" || p["faces"] != true || p["plates"] != true {
		t.Fatalf("params = %v", p)
	}
	if p["faceModel"] != e.m.modelPath(models[PresetFaces]) || p["plateModel"] != e.m.modelPath(models[PresetPlates]) {
		t.Fatalf("model paths = %v %v", p["faceModel"], p["plateModel"])
	}
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil {
		t.Fatal(err)
	}
	if res.Action != ActionDetect || len(res.Images) != 2 || res.Images[1].Path != b || res.Images[0].Width != 100 || len(res.Images[0].Boxes) != 2 || len(res.Outputs) != 0 {
		t.Fatalf("result = %+v", res)
	}
	if len(r.outputs) != 0 {
		t.Fatalf("detect registered outputs: %v", r.outputs)
	}
	if got := r.msgs[len(r.msgs)-1]; got != "2 faces · 2 plates" {
		t.Fatalf("summary = %q", got)
	}
	if r.progress[0] != 0.25 { // image 0 of 2, engine at 50%
		t.Fatalf("first progress = %v", r.progress[0])
	}
	if r.title != "2 images" {
		t.Fatalf("title = %q", r.title)
	}
}

func TestDetectOnlyAsksForTheWantedModels(t *testing.T) {
	e := newEnv(t, true)
	a := e.file(t, "a.jpg")
	e.fc.reply["redact.detect_image"] = `{"width":1,"height":1,"boxes":null}`
	r := &rec{}
	job := e.job(t, r, []string{a}, opts(func(o *Options) { o.Plates = false }))
	if err := e.m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	p := e.fc.calls[0].params
	if _, ok := p["plateModel"]; ok || p["plates"] != false {
		t.Fatalf("params = %v", p)
	}
	var res Result
	_ = json.Unmarshal(r.result, &res)
	if res.Images[0].Boxes == nil || len(res.Images[0].Boxes) != 0 {
		t.Fatalf("boxes = %v", res.Images[0].Boxes)
	}
	if r.msgs[len(r.msgs)-1] != "No faces or number plates found" {
		t.Fatalf("summary = %q", r.msgs[len(r.msgs)-1])
	}
}

func TestDetectWithoutModelsIsADependencyError(t *testing.T) {
	e := newEnv(t, false)
	a := e.file(t, "a.jpg")
	r := &rec{}
	err := e.m.Run(context.Background(), e.job(t, r, []string{a}, opts(nil)))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("err = %v", err)
	}
	if len(e.fc.calls) != 0 {
		t.Fatal("the engine was called without a model")
	}
}

func TestRunNeedsTheEngine(t *testing.T) {
	e := newEnv(t, true)
	a := e.file(t, "a.jpg")
	want := core.Errorf(core.CodeDependencyMissing, "no engine")
	r := &rec{tools: map[string]error{sidecar.DepID: want}}
	if err := e.m.Run(context.Background(), e.job(t, r, []string{a}, opts(nil))); !errors.Is(err, want) {
		t.Fatalf("err = %v", err)
	}
}

func TestApplyImagesNamesOutputsAndRegistersThem(t *testing.T) {
	e := newEnv(t, false) // apply needs no detection models
	a, b, c := e.file(t, "a.tiff"), e.file(t, "b.heic"), e.file(t, "sub/a.tiff")
	// An earlier output with the same name exists.
	outDir := filepath.Join(e.dir, "out")
	_ = os.MkdirAll(outDir, 0o755)
	if err := os.WriteFile(filepath.Join(outDir, "a (redacted).png"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.fc.reply["redact.apply_image"] = `{"width":1,"height":1,"applied":1}`
	e.fc.events["redact.apply_image"] = []sidecar.Event{{Kind: "output", Path: filepath.Join(outDir, "a (redacted) (1).png")}}
	o := opts(func(o *Options) {
		o.Action, o.Style, o.Strength, o.Padding, o.StripMetadata = ActionApply, StylePixelate, 8, 20, false
		o.ImageBoxes = map[string][]Box{a: {box("face")}, b: {}, c: {box("plate")}}
	})
	r := &rec{}
	if err := e.m.Run(context.Background(), e.job(t, r, []string{a, b, c}, o)); err != nil {
		t.Fatal(err)
	}
	if len(e.fc.calls) != 3 {
		t.Fatalf("calls = %d", len(e.fc.calls))
	}
	outs := []string{}
	for _, c := range e.fc.calls {
		if c.method != "redact.apply_image" {
			t.Fatalf("method = %s", c.method)
		}
		outs = append(outs, filepath.Base(c.params["out"].(string)))
	}
	// The fake engine writes no files, so the third name repeats the first.
	want := []string{"a (redacted) (1).png", "b (redacted).jpg", "a (redacted) (1).png"}
	if !reflect.DeepEqual(outs, want) {
		t.Fatalf("outs = %v, want %v", outs, want)
	}
	p := e.fc.calls[0].params
	if p["style"] != "pixelate" || p["strength"] != float64(8) || p["padding"] != float64(20) || p["stripMetadata"] != false {
		t.Fatalf("params = %v", p)
	}
	if bx, _ := p["boxes"].([]any); len(bx) != 1 {
		t.Fatalf("boxes = %v", p["boxes"])
	}
	if bx, ok := e.fc.calls[1].params["boxes"].([]any); !ok || len(bx) != 0 {
		t.Fatalf("empty box list should be sent as []: %v", e.fc.calls[1].params["boxes"])
	}
	var res Result
	_ = json.Unmarshal(r.result, &res)
	if len(res.Outputs) != 3 || len(res.Images) != 0 {
		t.Fatalf("result = %+v", res)
	}
	if len(r.outputs) != 2 { // the repeated name is registered once
		t.Fatalf("outputs registered = %v", r.outputs)
	}
}

func TestAutoImagesDetectsThenAppliesWithTheDetectedBoxes(t *testing.T) {
	e := newEnv(t, true)
	a := e.file(t, "a.jpg")
	e.fc.reply["redact.detect_image"] = `{"width":10,"height":10,"boxes":[{"id":"f1","x":0.1,"y":0.1,"w":0.2,"h":0.2,"kind":"face","enabled":true,"score":0.9}]}`
	e.fc.reply["redact.apply_image"] = `{"applied":1}`
	r := &rec{}
	if err := e.m.Run(context.Background(), e.job(t, r, []string{a}, opts(func(o *Options) { o.Action = ActionAuto }))); err != nil {
		t.Fatal(err)
	}
	if len(e.fc.calls) != 2 || e.fc.calls[0].method != "redact.detect_image" || e.fc.calls[1].method != "redact.apply_image" {
		t.Fatalf("calls = %+v", e.fc.calls)
	}
	if bx, _ := e.fc.calls[1].params["boxes"].([]any); len(bx) != 1 {
		t.Fatalf("boxes = %v", e.fc.calls[1].params["boxes"])
	}
	var res Result
	_ = json.Unmarshal(r.result, &res)
	if len(res.Outputs) != 1 || len(res.Images) != 1 || len(r.outputs) != 1 {
		t.Fatalf("result = %+v outputs = %v", res, r.outputs)
	}
}

const videoDetections = `{"width":1920,"height":1080,"durationMs":10000,"tracks":[
 {"id":"t1","kind":"face","startMs":0,"endMs":4000,"maxScore":0.95,"enabled":true,"samples":[{"ms":0,"x":0.1,"y":0.1,"w":0.1,"h":0.1}]},
 {"id":"t2","kind":"plate","startMs":500,"endMs":900,"maxScore":0.4,"enabled":false,"samples":null}]}`

func TestDetectVideoKeepsTheCacheFileAndReturnsTracks(t *testing.T) {
	e := newEnv(t, true)
	v := e.file(t, "clip.mp4")
	e.fc.reply["redact.detect_video"] = videoDetections
	r := &rec{}
	if err := e.m.Run(context.Background(), e.job(t, r, []string{v}, opts(nil))); err != nil {
		t.Fatal(err)
	}
	p := e.fc.calls[0].params
	wantCache := filepath.Join(e.cache, "job1.json")
	if p["cachePath"] != wantCache || p["ffmpeg"] != "/bin/ffmpeg" || p["path"] != v {
		t.Fatalf("params = %v", p)
	}
	var res Result
	_ = json.Unmarshal(r.result, &res)
	if res.Video == nil || res.Video.DetectionsPath != wantCache || len(res.Video.Tracks) != 2 || res.Video.Tracks[1].Samples == nil {
		t.Fatalf("result = %+v", res.Video)
	}
	if len(r.outputs) != 0 {
		t.Fatalf("outputs = %v", r.outputs)
	}
	if !strings.Contains(r.msgs[len(r.msgs)-1], "1 face or plate track") {
		t.Fatalf("summary = %q", r.msgs[len(r.msgs)-1])
	}
}

func TestApplyVideoPassesTheOptionsThrough(t *testing.T) {
	e := newEnv(t, false)
	v := e.file(t, "clip.mkv")
	det := filepath.Join(e.cache, "job9.json")
	e.fc.reply["redact.apply_video"] = `{"out":"` + strings.ReplaceAll(filepath.Join(e.dir, "out", "clip (redacted).mp4"), `\`, `\\`) + `"}`
	o := opts(func(o *Options) {
		o.Action, o.DetectionsPath, o.DisabledTracks = ActionApply, det, []string{"t2"}
		o.ManualBoxes = []TimedBox{{Box: box("manual"), StartMs: 1000, EndMs: 4000}}
		o.Style, o.StripMetadata = StyleSolid, false
	})
	r := &rec{}
	if err := e.m.Run(context.Background(), e.job(t, r, []string{v}, o)); err != nil {
		t.Fatal(err)
	}
	p := e.fc.calls[0].params
	if e.fc.calls[0].method != "redact.apply_video" || p["detectionsPath"] != det || p["style"] != "solid" || p["stripMetadata"] != false {
		t.Fatalf("params = %v", p)
	}
	if d, _ := p["disabledTracks"].([]any); len(d) != 1 || d[0] != "t2" {
		t.Fatalf("disabled = %v", p["disabledTracks"])
	}
	m, _ := p["manualBoxes"].([]any)
	if len(m) != 1 {
		t.Fatalf("manual = %v", p["manualBoxes"])
	}
	if mb := m[0].(map[string]any); mb["startMs"] != float64(1000) || mb["endMs"] != float64(4000) || mb["x"] != 0.1 || mb["kind"] != "manual" {
		t.Fatalf("manual box = %v", mb)
	}
	if filepath.Base(p["out"].(string)) != "clip (redacted).mp4" {
		t.Fatalf("out = %v", p["out"])
	}
	if len(r.outputs) != 1 {
		t.Fatalf("outputs = %v", r.outputs)
	}
}

func TestApplyVideoRefusesDetectionsOutsideTheCache(t *testing.T) {
	e := newEnv(t, false)
	v := e.file(t, "clip.mp4")
	o := opts(func(o *Options) { o.Action, o.DetectionsPath = ActionApply, filepath.Join(e.dir, "evil.json") })
	r := &rec{}
	if err := e.m.Run(context.Background(), e.job(t, r, []string{v}, o)); err == nil {
		t.Fatal("expected an error")
	}
	if len(e.fc.calls) != 0 {
		t.Fatal("the engine was called")
	}
}

func TestAutoVideoDisablesWeakTracksAndKeepsNoCacheFile(t *testing.T) {
	e := newEnv(t, true)
	v := e.file(t, "clip.mp4")
	e.fc.reply["redact.detect_video"] = videoDetections
	e.fc.reply["redact.apply_video"] = `{}`
	r := &rec{}
	job := e.job(t, r, []string{v}, opts(func(o *Options) { o.Action = ActionAuto }))
	if err := e.m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(e.fc.calls) != 2 {
		t.Fatalf("calls = %d", len(e.fc.calls))
	}
	if cp := e.fc.calls[0].params["cachePath"].(string); !strings.HasPrefix(cp, job.TempDir) {
		t.Fatalf("auto cache path = %s (should be in the job temp dir)", cp)
	}
	a := e.fc.calls[1].params
	if d, _ := a["disabledTracks"].([]any); len(d) != 1 || d[0] != "t2" {
		t.Fatalf("disabled = %v", a["disabledTracks"])
	}
	if a["detectionsPath"] != e.fc.calls[0].params["cachePath"] {
		t.Fatalf("detectionsPath = %v", a["detectionsPath"])
	}
	if len(r.outputs) != 1 {
		t.Fatalf("outputs = %v", r.outputs)
	}
}

func TestEngineErrorsPropagate(t *testing.T) {
	e := newEnv(t, true)
	a := e.file(t, "a.jpg")
	e.fc.err = core.Errorf(core.CodeToolFailed, "boom")
	r := &rec{}
	err := e.m.Run(context.Background(), e.job(t, r, []string{a}, opts(nil)))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Message != "boom" {
		t.Fatalf("err = %v", err)
	}
}

func TestModelProvider(t *testing.T) {
	e := newEnv(t, false)
	if e.m.ModelPresent(PresetFaces) || e.m.ModelPresent("nope") {
		t.Fatal("nothing is installed yet")
	}
	e.fc.reply["redact.prefetch"] = `{}`
	r := &rec{}
	job := e.job(t, r, nil, opts(nil))
	if err := e.m.FetchModel(context.Background(), job, PresetPlates); err != nil {
		t.Fatal(err)
	}
	c := e.fc.calls[0]
	spec := c.params["model"].(map[string]any)
	if c.method != "redact.prefetch" || spec["file"] != models[PresetPlates].File || spec["sha256"] != models[PresetPlates].SHA256 ||
		spec["url"] != models[PresetPlates].URL || c.params["modelDir"] != filepath.Join(e.models, "redact") {
		t.Fatalf("call = %+v", c)
	}
	if err := e.m.FetchModel(context.Background(), job, "bogus"); err == nil {
		t.Fatal("unknown preset should fail")
	}
	// Present models are not fetched again, and RemoveModel deletes the file.
	e2 := newEnv(t, true)
	if !e2.m.ModelPresent(PresetFaces) || !e2.m.ModelPresent(PresetPlates) {
		t.Fatal("models should be present")
	}
	if err := e2.m.FetchModel(context.Background(), job, PresetFaces); err != nil || len(e2.fc.calls) != 0 {
		t.Fatalf("fetch of a present model: err=%v calls=%d", err, len(e2.fc.calls))
	}
	if err := e2.m.RemoveModel(PresetFaces); err != nil || e2.m.ModelPresent(PresetFaces) || !e2.m.ModelPresent(PresetPlates) {
		t.Fatalf("remove failed: %v", err)
	}
	if err := e2.m.RemoveModel(PresetFaces); err != nil {
		t.Fatalf("removing twice: %v", err)
	}
}

func TestModelPinsLookRight(t *testing.T) {
	for id, s := range models {
		if len(s.SHA256) != 64 || !strings.HasPrefix(s.URL, "https://") || filepath.Base(s.File) != s.File || s.Bytes <= 0 {
			t.Errorf("%s: bad pin %+v", id, s)
		}
	}
	if models[PresetFaces].Bytes != 232_589 || models[PresetPlates].Bytes != 7_835_770 {
		t.Error("sizes differ from SPEC §0.4")
	}
}

func TestPruneCacheRemovesOldFilesOnly(t *testing.T) {
	e := newEnv(t, false)
	if err := os.MkdirAll(e.cache, 0o755); err != nil {
		t.Fatal(err)
	}
	old, fresh := filepath.Join(e.cache, "old.json"), filepath.Join(e.cache, "fresh.json")
	for _, p := range []string{old, fresh} {
		if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ago := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(old, ago, ago); err != nil {
		t.Fatal(err)
	}
	e.m.PruneCache()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old file kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh file removed")
	}
	(&Module{}).PruneCache() // no cache dir: a no-op, not a crash
}

func TestDescriptor(t *testing.T) {
	d := (&Module{}).Descriptor()
	if d.ID != ModuleID || d.MaxInputs != 100 || len(d.Requires) != 3 {
		t.Fatalf("descriptor = %+v", d)
	}
}
