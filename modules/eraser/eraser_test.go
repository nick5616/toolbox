package eraser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
)

type fakeCaller struct {
	calls  int
	method string
	params map[string]any
	events []sidecar.Event
	result string
	err    error
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.calls++
	f.method = method
	f.params, _ = params.(map[string]any)
	for _, ev := range f.events {
		onEvent(ev)
	}
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.result), nil
}

type rec struct {
	outputs []string
	result  json.RawMessage
	last    string
	toolErr error
}

func (r *rec) hooks() core.JobHooks {
	return core.JobHooks{
		Progress: func(_ float64, m string) { r.last = m },
		Log:      func(core.LogStream, string) {},
		Title:    func(string) {},
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool:   func(string) (string, error) { return "/engine", r.toolErr },
		Result: func(b json.RawMessage) { r.result = b },
	}
}

func touch(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func newJob(r *rec, input, opts string, outDir string) *core.JobContext {
	return core.NewJobContext(core.JobContext{Inputs: []string{input}, Options: json.RawMessage(opts), OutputDir: outDir}, r.hooks())
}

func optsJSON(t *testing.T, o Options) string {
	t.Helper()
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func maskB64(t *testing.T, w, h int, paint bool) string {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, w, h))
	if paint {
		img.SetGray(w/2, h/2, color.Gray{Y: 255})
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestValidate(t *testing.T) {
	maskDir := t.TempDir()
	m := &Module{maskDir: maskDir}
	input := touch(t, t.TempDir(), "a.jpg")
	txt := touch(t, t.TempDir(), "a.txt")
	mask := touch(t, maskDir, "m.png")
	outside := touch(t, t.TempDir(), "m.png")
	nested := filepath.Join(maskDir, "sub")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	nestedMask := touch(t, nested, "m.png")
	tests := []struct {
		name   string
		inputs []string
		opts   Options
		ok     bool
	}{
		{"good", []string{input}, Options{Model: ModelBest, MaskPath: mask}, true},
		{"fast", []string{input}, Options{Model: ModelFast, MaskPath: mask}, true},
		{"bad model", []string{input}, Options{Model: "x", MaskPath: mask}, false},
		{"mask outside", []string{input}, Options{Model: ModelBest, MaskPath: outside}, false},
		{"mask nested", []string{input}, Options{Model: ModelBest, MaskPath: nestedMask}, false},
		{"mask traversal", []string{input}, Options{Model: ModelBest, MaskPath: filepath.Join(maskDir, "..", filepath.Base(filepath.Dir(outside)), "m.png")}, false},
		{"mask missing", []string{input}, Options{Model: ModelBest, MaskPath: filepath.Join(maskDir, "none.png")}, false},
		{"no mask", []string{input}, Options{Model: ModelBest}, false},
		{"bad ext", []string{txt}, Options{Model: ModelBest, MaskPath: mask}, false},
		{"no input", nil, Options{Model: ModelBest, MaskPath: mask}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := m.Validate(tt.inputs, json.RawMessage(optsJSON(t, tt.opts)))
			if (err == nil) != tt.ok {
				t.Fatalf("err %v, want ok=%v", err, tt.ok)
			}
		})
	}
}

func TestRun(t *testing.T) {
	maskDir, modelsDir := t.TempDir(), t.TempDir()
	input := touch(t, t.TempDir(), "Cat.jpg")
	out := filepath.Join(t.TempDir(), "Cat (erased).jpg")
	spec := models[ModelBest]
	if err := os.MkdirAll(filepath.Join(modelsDir, "eraser"), 0o755); err != nil {
		t.Fatal(err)
	}
	touch(t, filepath.Join(modelsDir, "eraser"), spec.File)

	t.Run("success deletes mask", func(t *testing.T) {
		mask := touch(t, maskDir, "a.png")
		r := &rec{}
		fc := &fakeCaller{
			events: []sidecar.Event{{Kind: "output", Path: out}},
			result: `{"regions":2,"warning":"Large areas may look smeared","output":` + quote(out) + `}`,
		}
		m := &Module{sc: fc, modelsDir: modelsDir, maskDir: maskDir}
		outDir := t.TempDir()
		if err := m.Run(context.Background(), newJob(r, input, optsJSON(t, Options{Model: ModelBest, MaskPath: mask}), outDir)); err != nil {
			t.Fatal(err)
		}
		if fc.method != "eraser.inpaint" || fc.calls != 1 {
			t.Fatalf("method %q calls %d", fc.method, fc.calls)
		}
		want := map[string]any{
			"path": input, "mask": mask, "out": outDir, "model": "best",
			"modelPath": filepath.Join(modelsDir, "eraser", spec.File),
		}
		for k, v := range want {
			if fc.params[k] != v {
				t.Errorf("param %s = %v, want %v", k, fc.params[k], v)
			}
		}
		if len(r.outputs) != 1 || r.outputs[0] != out {
			t.Errorf("outputs %v", r.outputs)
		}
		var res Result
		if err := json.Unmarshal(r.result, &res); err != nil || res.Regions != 2 || res.Warning == "" || len(res.Outputs) != 1 {
			t.Errorf("result %s (%v)", r.result, err)
		}
		if r.last != "Large areas may look smeared" {
			t.Errorf("final message %q", r.last)
		}
		if _, err := os.Stat(mask); !os.IsNotExist(err) {
			t.Error("mask not deleted after success")
		}
	})

	t.Run("failure deletes mask", func(t *testing.T) {
		mask := touch(t, maskDir, "b.png")
		want := core.Errorf(core.CodeToolFailed, "boom")
		m := &Module{sc: &fakeCaller{err: want}, modelsDir: modelsDir, maskDir: maskDir}
		err := m.Run(context.Background(), newJob(&rec{}, input, optsJSON(t, Options{Model: ModelBest, MaskPath: mask}), t.TempDir()))
		if err != want {
			t.Fatalf("err %v", err)
		}
		if _, err := os.Stat(mask); !os.IsNotExist(err) {
			t.Error("mask not deleted after failure")
		}
	})

	t.Run("engine missing deletes mask", func(t *testing.T) {
		mask := touch(t, maskDir, "c.png")
		r := &rec{toolErr: core.ErrDependencyMissing(sidecar.DepID, "Install it")}
		fc := &fakeCaller{}
		m := &Module{sc: fc, modelsDir: modelsDir, maskDir: maskDir}
		err := m.Run(context.Background(), newJob(r, input, optsJSON(t, Options{Model: ModelBest, MaskPath: mask}), t.TempDir()))
		if err != r.toolErr || fc.calls != 0 {
			t.Fatalf("err %v calls %d", err, fc.calls)
		}
		if _, err := os.Stat(mask); !os.IsNotExist(err) {
			t.Error("mask not deleted")
		}
	})

	t.Run("cancelled deletes mask", func(t *testing.T) {
		mask := touch(t, maskDir, "d.png")
		m := &Module{sc: &fakeCaller{err: context.Canceled}, modelsDir: modelsDir, maskDir: maskDir}
		err := m.Run(context.Background(), newJob(&rec{}, input, optsJSON(t, Options{Model: ModelBest, MaskPath: mask}), t.TempDir()))
		if err == nil {
			t.Fatal("expected error")
		}
		if _, err := os.Stat(mask); !os.IsNotExist(err) {
			t.Error("mask not deleted")
		}
	})

	t.Run("mask outside folder is not deleted", func(t *testing.T) {
		outside := touch(t, t.TempDir(), "keep.png")
		m := &Module{sc: &fakeCaller{}, modelsDir: modelsDir, maskDir: maskDir}
		if err := m.Run(context.Background(), newJob(&rec{}, input, optsJSON(t, Options{Model: ModelBest, MaskPath: outside}), t.TempDir())); err == nil {
			t.Fatal("expected validation error")
		}
		if _, err := os.Stat(outside); err != nil {
			t.Error("outside file was deleted")
		}
	})

	t.Run("missing model is fetched first", func(t *testing.T) {
		mask := touch(t, maskDir, "e.png")
		fc := &fakeCaller{result: `{"regions":1,"warning":"","output":""}`}
		m := &Module{sc: fc, modelsDir: t.TempDir(), maskDir: maskDir}
		if err := m.Run(context.Background(), newJob(&rec{}, input, optsJSON(t, Options{Model: ModelFast, MaskPath: mask}), t.TempDir())); err != nil {
			t.Fatal(err)
		}
		if fc.calls != 2 || fc.method != "eraser.inpaint" {
			t.Fatalf("calls %d last method %q", fc.calls, fc.method)
		}
	})
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestModelProvider(t *testing.T) {
	dir := t.TempDir()
	fc := &fakeCaller{result: `{}`}
	m := &Module{sc: fc, modelsDir: dir}
	job := newJob(&rec{}, "x", `{}`, t.TempDir())

	if m.ModelPresent("best") || m.ModelPresent("nope") {
		t.Fatal("present before download")
	}
	if err := m.FetchModel(context.Background(), job, "fast"); err != nil {
		t.Fatal(err)
	}
	if fc.method != "eraser.prefetch" || fc.calls != 1 {
		t.Fatalf("calls %d method %q", fc.calls, fc.method)
	}
	if fc.params["modelDir"] != filepath.Join(dir, "eraser") {
		t.Errorf("modelDir %v", fc.params["modelDir"])
	}
	mm := fc.params["model"].(map[string]any)
	if mm["file"] != "migan_pipeline_v2.onnx" || len(mm["sha256"].(string)) != 64 {
		t.Errorf("model %v", mm)
	}
	f := filepath.Join(dir, "eraser", models[ModelFast].File)
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !m.ModelPresent("fast") {
		t.Fatal("not present after write")
	}
	st := m.modelStatus()
	if len(st) != 2 || st[0].ID != ModelBest || st[0].Present || !st[1].Present || st[0].DownloadBytes != 208_044_816 {
		t.Errorf("status %+v", st)
	}
	if err := m.FetchModel(context.Background(), job, "fast"); err != nil || fc.calls != 1 {
		t.Errorf("fetch when present: %v calls %d", err, fc.calls)
	}
	if err := m.RemoveModel("fast"); err != nil || m.ModelPresent("fast") {
		t.Errorf("remove: %v", err)
	}
	if err := m.RemoveModel("fast"); err != nil {
		t.Errorf("second remove: %v", err)
	}
	if err := m.FetchModel(context.Background(), job, "bogus"); err == nil {
		t.Error("unknown preset accepted")
	}
}

func TestDecodeMask(t *testing.T) {
	ok := maskB64(t, 40, 30, true)
	if _, img, err := decodeMask("data:image/png;base64," + ok); err != nil || !maskPainted(img) {
		t.Fatalf("data URL: %v", err)
	}
	if _, img, err := decodeMask(ok); err != nil || !maskPainted(img) {
		t.Fatalf("raw: %v", err)
	}
	if _, img, err := decodeMask(maskB64(t, 40, 30, false)); err != nil || maskPainted(img) {
		t.Fatalf("empty mask: err %v", err)
	}
	for name, in := range map[string]string{
		"empty":     "",
		"not b64":   "***",
		"not png":   base64.StdEncoding.EncodeToString([]byte("hello")),
		"too large": maskB64(t, 8193, 1, true),
	} {
		if _, _, err := decodeMask(in); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestAspectOK(t *testing.T) {
	tests := []struct {
		mw, mh, iw, ih int
		ok             bool
	}{
		{400, 300, 4000, 3000, true},
		{400, 300, 4000, 3020, true},
		{400, 300, 4000, 3200, false},
		{300, 400, 4000, 3000, true}, // rotated by EXIF
		{100, 100, 4000, 3000, false},
	}
	for _, tt := range tests {
		if got := aspectOK(tt.mw, tt.mh, tt.iw, tt.ih); got != tt.ok {
			t.Errorf("%+v = %v", tt, got)
		}
	}
}

func TestClearMasks(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "a.png")
	touch(t, dir, "b.png")
	m := &Module{maskDir: dir}
	m.ClearMasks()
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("left %d", len(entries))
	}
	(&Module{maskDir: filepath.Join(dir, "missing")}).ClearMasks() // must not panic
}
