package upscale

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/sidecar"
)

// setup builds a module with a fake sidecar, a fake install and a 8×6 PNG.
type env struct {
	m      *Module
	sc     *fakeCaller
	rec    *jobRec
	exe    string
	in     string
	outDir string
	log    string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	t.Setenv("FAKE_UPSCAYL", "1")
	e := &env{sc: &fakeCaller{}, rec: &jobRec{}}
	e.exe = fakeInstall(t)
	e.m = &Module{sc: e.sc, modelsDir: filepath.Join(t.TempDir(), "models")}
	e.rec.tools = map[string]string{deps.Upscayl: e.exe}
	dir := t.TempDir()
	e.in = filepath.Join(dir, "photo.png")
	writePNG(t, e.in, 8, 6, false)
	e.outDir = filepath.Join(dir, "Upscaled")
	e.log = filepath.Join(dir, "args.log")
	t.Setenv("FAKE_UPSCAYL_LOG", e.log)
	return e
}

func (e *env) run(t *testing.T, opts Options) error {
	t.Helper()
	return e.m.Run(context.Background(), e.rec.job(t, []string{e.in}, opts, e.outDir))
}

// invocations returns every recorded fake upscayl-bin argument list.
func (e *env) invocations(t *testing.T) [][]string {
	t.Helper()
	b, err := os.ReadFile(e.log)
	if err != nil {
		return nil
	}
	var out [][]string
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		out = append(out, strings.Split(strings.TrimRight(l, "\r"), "\x1f"))
	}
	return out
}

func flag(args []string, name string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == name {
			return args[i+1]
		}
	}
	return ""
}

func appErr(t *testing.T, err error, code core.ErrorCode, msg string) *core.AppError {
	t.Helper()
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != code || (msg != "" && ae.Message != msg) {
		t.Fatalf("err = %v, want %s %q", err, code, msg)
	}
	return ae
}

func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	ents, _ := os.ReadDir(dir)
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func TestRunGPUFlagMapping(t *testing.T) {
	tests := []struct {
		model  Model
		scale  int
		n      string
		z, s   string
		format Format
		ext    string
		c      string
	}{
		{ModelPhoto, 2, "realesrgan-x4plus", "4", "2", FormatPNG, ".png", ""},
		{ModelPhoto, 4, "realesrgan-x4plus", "4", "4", FormatPNG, ".png", ""},
		{ModelIllustration, 2, "realesrgan-x4plus-anime", "4", "2", FormatPNG, ".png", ""},
		{ModelIllustration, 4, "realesrgan-x4plus-anime", "4", "4", FormatJPG, ".jpg", ""},
		{ModelFast, 2, "realesr-animevideov3-x2", "2", "2", FormatWebP, ".webp", "10"},
		{ModelFast, 4, "realesr-animevideov3-x4", "4", "4", FormatSame, ".png", ""},
	}
	for _, tc := range tests {
		t.Run(string(tc.model)+tc.s+tc.ext, func(t *testing.T) {
			e := newEnv(t)
			o := Options{Model: tc.model, Scale: tc.scale, Format: tc.format, Device: DeviceGPU}
			if err := e.run(t, o); err != nil {
				t.Fatal(err)
			}
			inv := e.invocations(t)
			if len(inv) != 1 {
				t.Fatalf("invocations %v", inv)
			}
			a := inv[0]
			if flag(a, "-n") != tc.n || flag(a, "-z") != tc.z || flag(a, "-s") != tc.s || flag(a, "-t") != "0" || flag(a, "-c") != tc.c {
				t.Errorf("args %q", a)
			}
			if flag(a, "-i") != e.in {
				t.Errorf("input %q", flag(a, "-i"))
			}
			m := flag(a, "-m")
			if filepath.Base(m) != "models" || filepath.Dir(m) != filepath.Dir(e.exe) {
				t.Errorf("-m %q", m)
			}
			tmp := flag(a, "-o")
			if !strings.HasPrefix(filepath.Base(tmp), ".") || !strings.HasSuffix(tmp, ".tmp"+tc.ext) || filepath.Dir(tmp) != e.outDir {
				t.Errorf("tmp name %q", tmp)
			}
			want := filepath.Join(e.outDir, "photo ("+tc.s+"x)"+tc.ext)
			if len(e.rec.outputs) != 1 || e.rec.outputs[0] != want {
				t.Fatalf("outputs %v, want %s", e.rec.outputs, want)
			}
			if l := leftovers(t, e.outDir); len(l) != 1 {
				t.Errorf("leftovers %v", l)
			}
		})
	}
}

func TestRunResultAndNaming(t *testing.T) {
	e := newEnv(t)
	o := DefaultOptions()
	o.Device = DeviceGPU
	if err := e.run(t, o); err != nil {
		t.Fatal(err)
	}
	var res Result
	if err := json.Unmarshal(e.rec.result, &res); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(e.outDir, "photo (4x).png")
	if res.InWidth != 8 || res.InHeight != 6 || res.OutWidth != 32 || res.OutHeight != 24 ||
		res.Model != ModelPhoto || res.Scale != 4 || res.Device != "gpu" || res.Output != want || res.Bytes <= 0 {
		t.Errorf("result %+v", res)
	}
	if e.rec.lastMsg() != "8×6 → 32×24" || e.rec.pcts[len(e.rec.pcts)-1] != 1 {
		t.Errorf("message %q", e.rec.lastMsg())
	}
	// Second run does not overwrite.
	e.rec.outputs = nil
	if err := e.run(t, o); err != nil {
		t.Fatal(err)
	}
	if got := filepath.Base(e.rec.outputs[0]); got != "photo (4x) (1).png" {
		t.Errorf("second output %q", got)
	}
	// Input untouched and still decodes.
	if _, err := os.Stat(e.in); err != nil {
		t.Error(err)
	}
}

func TestRunProgressParsing(t *testing.T) {
	e := newEnv(t)
	o := DefaultOptions()
	o.Device = DeviceGPU
	if err := e.run(t, o); err != nil {
		t.Fatal(err)
	}
	e.rec.mu.Lock()
	defer e.rec.mu.Unlock()
	if e.rec.msgs[0] != "Starting GPU…" || e.rec.pcts[0] != core.IndeterminateProgress {
		t.Errorf("first: %q %v", e.rec.msgs[0], e.rec.pcts[0])
	}
	seen := map[string]bool{}
	for i, m := range e.rec.msgs {
		seen[m] = true
		if m == "Upscaling · 50%" && e.rec.pcts[i] != 0.5 {
			t.Errorf("50%% mapped to %v", e.rec.pcts[i])
		}
	}
	for _, m := range []string{"Upscaling · 0%", "Upscaling · 50%", "Upscaling · 100%"} {
		if !seen[m] {
			t.Errorf("missing %q in %v", m, e.rec.msgs)
		}
	}
	// % lines are not logged; other stderr lines are.
	for _, l := range e.rec.logs {
		if strings.Contains(l, "%") {
			t.Errorf("progress line logged: %q", l)
		}
	}
	found := false
	for _, l := range e.rec.logs {
		found = found || strings.Contains(l, "queueC")
	}
	if !found {
		t.Errorf("stderr not logged: %v", e.rec.logs)
	}
}

func TestRunStartupNotice(t *testing.T) {
	old := startupNotice
	startupNotice = 30 * time.Millisecond
	defer func() { startupNotice = old }()
	e := newEnv(t)
	t.Setenv("FAKE_UPSCAYL_DELAY", "600")
	o := DefaultOptions()
	o.Device = DeviceGPU
	if err := e.run(t, o); err != nil {
		t.Fatal(err)
	}
	e.rec.mu.Lock()
	defer e.rec.mu.Unlock()
	found := false
	for _, m := range e.rec.msgs {
		found = found || strings.HasPrefix(m, "Starting GPU — the first run")
	}
	if !found {
		t.Errorf("no startup notice in %v", e.rec.msgs)
	}
}

func TestRunErrors(t *testing.T) {
	t.Run("no gpu (non-zero exit)", func(t *testing.T) {
		e := newEnv(t)
		t.Setenv("FAKE_UPSCAYL_MODE", "gpuerr")
		o := DefaultOptions()
		o.Device = DeviceGPU
		ae := appErr(t, e.run(t, o), core.CodeDependencyMissing, "No compatible GPU found")
		if !strings.Contains(ae.Hint, "Vulkan") {
			t.Errorf("hint %q", ae.Hint)
		}
		if l := leftovers(t, e.outDir); len(l) != 0 {
			t.Errorf("leftovers %v", l)
		}
	})
	t.Run("no gpu (exit 0)", func(t *testing.T) {
		e := newEnv(t)
		t.Setenv("FAKE_UPSCAYL_MODE", "gpuerr0")
		o := DefaultOptions()
		o.Device = DeviceGPU
		appErr(t, e.run(t, o), core.CodeDependencyMissing, "No compatible GPU found")
	})
	t.Run("exit 0 without output", func(t *testing.T) {
		e := newEnv(t)
		t.Setenv("FAKE_UPSCAYL_MODE", "nooutput")
		o := DefaultOptions()
		o.Device = DeviceGPU
		appErr(t, e.run(t, o), core.CodeToolFailed, "Upscaling failed")
	})
	t.Run("crash logs the last 5 stderr lines", func(t *testing.T) {
		e := newEnv(t)
		t.Setenv("FAKE_UPSCAYL_MODE", "crash")
		o := DefaultOptions()
		o.Device = DeviceGPU
		appErr(t, e.run(t, o), core.CodeToolFailed, "Upscaling failed")
		for _, l := range []string{"l3", "l4", "l5", "l6", "boom"} {
			if !e.rec.hasLog(l) {
				t.Errorf("log missing %q: %v", l, e.rec.logs)
			}
		}
	})
	t.Run("models missing", func(t *testing.T) {
		e := newEnv(t)
		os.Remove(filepath.Join(filepath.Dir(e.exe), "models", "realesrgan-x4plus.bin"))
		o := DefaultOptions()
		o.Device = DeviceGPU
		ae := appErr(t, e.run(t, o), core.CodeDependencyMissing, "Upscaler models are missing")
		if !strings.Contains(ae.Hint, "Reinstall the upscaler") {
			t.Errorf("hint %q", ae.Hint)
		}
		if len(e.invocations(t)) != 0 {
			t.Error("binary should not run")
		}
	})
	t.Run("cap re-checked at run", func(t *testing.T) {
		e := newEnv(t)
		writeHugePNGHeader(t, e.in, 6000, 5000)
		o := DefaultOptions()
		o.Device = DeviceGPU
		appErr(t, e.run(t, o), core.CodeValidation, "")
	})
}

func TestRunCancelRemovesTmp(t *testing.T) {
	e := newEnv(t)
	t.Setenv("FAKE_UPSCAYL_MODE", "hang")
	o := DefaultOptions()
	o.Device = DeviceGPU
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	job := e.rec.job(t, []string{e.in}, o, e.outDir)
	go func() { done <- e.m.Run(ctx, job) }()
	// Wait until the fake wrote its partial output.
	deadline := time.Now().Add(20 * time.Second)
	for {
		e.rec.mu.Lock()
		started := false
		for _, m := range e.rec.msgs {
			started = started || m == "Upscaling · 0%"
		}
		e.rec.mu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("run did not return after cancel")
	}
	if l := leftovers(t, e.outDir); len(l) != 0 {
		t.Errorf("leftovers after cancel: %v", l)
	}
	if len(e.rec.outputs) != 0 {
		t.Errorf("outputs %v", e.rec.outputs)
	}
}

func TestRunOutputFormat(t *testing.T) {
	tests := []struct {
		name   string
		prep   func(t *testing.T, e *env)
		format Format
		want   string
	}{
		{"alpha png forced to png despite jpg", func(t *testing.T, e *env) { writePNG(t, e.in, 8, 6, true) }, FormatJPG, ".png"},
		{"alpha png forced to png despite webp", func(t *testing.T, e *env) { writePNG(t, e.in, 8, 6, true) }, FormatWebP, ".png"},
		{"opaque png honours jpg", func(t *testing.T, e *env) {}, FormatJPG, ".jpg"},
		{"jpeg same → jpg", func(t *testing.T, e *env) {
			e.in = filepath.Join(filepath.Dir(e.in), "pic.jpeg")
			writeJPEG(t, e.in, 8, 6)
		}, FormatSame, ".jpg"},
		{"jpeg to png", func(t *testing.T, e *env) {
			e.in = filepath.Join(filepath.Dir(e.in), "pic.jpg")
			writeJPEG(t, e.in, 8, 6)
		}, FormatPNG, ".png"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			tc.prep(t, e)
			o := Options{Model: ModelFast, Scale: 2, Format: tc.format, Device: DeviceGPU}
			if err := e.run(t, o); err != nil {
				t.Fatal(err)
			}
			if got := filepath.Ext(e.rec.outputs[0]); got != tc.want {
				t.Errorf("ext %s, want %s (%s)", got, tc.want, e.rec.outputs[0])
			}
		})
	}
}

// fakeEngine answers image.convert / upscale.run.
func fakeEngine(t *testing.T) func(context.Context, string, map[string]any, func(sidecar.Event)) (any, error) {
	return func(_ context.Context, method string, p map[string]any, on func(sidecar.Event)) (any, error) {
		switch method {
		case "image.convert":
			writePNG(t, p["output"].(string), 20, 10, false)
			return map[string]int{"width": 20, "height": 10}, nil
		case "upscale.run":
			out := p["output"].(string)
			writePNG(t, out, 32, 24, false)
			if on != nil {
				on(sidecar.Event{Kind: "progress", Pct: 0.5, Msg: "Upscaling · 50%"})
				on(sidecar.Event{Kind: "log", Line: "tile 1/2"})
			}
			return map[string]any{"inWidth": 8, "inHeight": 6, "outWidth": 32, "outHeight": 24, "device": "cpu"}, nil
		}
		return nil, errors.New("unexpected " + method)
	}
}

func TestRunHEIC(t *testing.T) {
	setup := func(t *testing.T) *env {
		e := newEnv(t)
		e.in = filepath.Join(filepath.Dir(e.in), "IMG_0001.HEIC")
		os.WriteFile(e.in, []byte("heic-bytes"), 0o644)
		e.sc.handle = fakeEngine(t)
		e.rec.tools[sidecar.DepID] = "/engine"
		return e
	}
	t.Run("converts to a temp PNG then upscales it", func(t *testing.T) {
		e := setup(t)
		o := DefaultOptions()
		o.Device = DeviceGPU
		if err := e.run(t, o); err != nil {
			t.Fatal(err)
		}
		if m := e.sc.methods(); len(m) != 1 || m[0] != "image.convert" {
			t.Fatalf("engine calls %v", m)
		}
		c := e.sc.calls[0].Params
		if c["input"] != e.in || filepath.Base(c["output"].(string)) != "IMG_0001.png" {
			t.Errorf("convert params %v", c)
		}
		a := e.invocations(t)[0]
		if flag(a, "-i") != c["output"] {
			t.Errorf("upscayl input %q, want the converted PNG %v", flag(a, "-i"), c["output"])
		}
		if got := filepath.Base(e.rec.outputs[0]); got != "IMG_0001 (4x).png" {
			t.Errorf("output %q", got)
		}
		var res Result
		json.Unmarshal(e.rec.result, &res)
		if res.InWidth != 20 || res.InHeight != 10 || res.OutWidth != 80 || res.OutHeight != 40 {
			t.Errorf("result %+v", res)
		}
	})
	t.Run("engine missing", func(t *testing.T) {
		e := setup(t)
		delete(e.rec.tools, sidecar.DepID)
		ae := appErr(t, e.run(t, DefaultOptions()), core.CodeDependencyMissing, "HEIC photos need the AI engine")
		if !strings.Contains(ae.Hint, sidecar.DepID) {
			t.Errorf("hint %q", ae.Hint)
		}
		if len(e.invocations(t)) != 0 {
			t.Error("must not run upscayl")
		}
	})
	t.Run("size cap applies to the converted size", func(t *testing.T) {
		e := setup(t)
		e.sc.handle = func(_ context.Context, _ string, p map[string]any, _ func(sidecar.Event)) (any, error) {
			writeHugePNGHeader(t, p["output"].(string), 6000, 5000)
			return map[string]int{"width": 6000, "height": 5000}, nil
		}
		appErr(t, e.run(t, DefaultOptions()), core.CodeValidation, "")
	})
	t.Run("jpg requested", func(t *testing.T) {
		e := setup(t)
		o := Options{Model: ModelPhoto, Scale: 2, Format: FormatJPG, Device: DeviceGPU}
		if err := e.run(t, o); err != nil {
			t.Fatal(err)
		}
		if filepath.Ext(e.rec.outputs[0]) != ".jpg" {
			t.Errorf("%v", e.rec.outputs)
		}
	})
}

func TestRunDeviceSelection(t *testing.T) {
	type tc struct {
		name       string
		device     Device
		gpuMode    string // fake mode ("" = ok)
		noGPUDep   bool   // upscayl not installed
		noEngine   bool
		big        bool // input over the CPU cap (3 MP)
		wantGPU    bool
		wantCPU    bool
		wantErr    string // message, "" = success
		wantDevice string
		wantLog    string
	}
	tests := []tc{
		{name: "auto, gpu works", device: DeviceAuto, wantGPU: true, wantDevice: "gpu"},
		{name: "auto, no gpu falls back to cpu", device: DeviceAuto, gpuMode: "gpuerr", wantGPU: true, wantCPU: true,
			wantDevice: "cpu", wantLog: "No compatible GPU — using the CPU (slower)"},
		{name: "auto, upscayl not installed uses cpu", device: DeviceAuto, noGPUDep: true, wantCPU: true, wantDevice: "cpu"},
		{name: "auto, no gpu and no engine keeps gpu error", device: DeviceAuto, gpuMode: "gpuerr", noEngine: true, wantGPU: true,
			wantErr: "No compatible GPU found"},
		{name: "auto, no gpu and over cpu cap keeps gpu error", device: DeviceAuto, gpuMode: "gpuerr", big: true, wantGPU: true,
			wantErr: "No compatible GPU found"},
		{name: "auto, not installed and no engine keeps original error", device: DeviceAuto, noGPUDep: true, noEngine: true,
			wantErr: "upscayl isn't installed"},
		{name: "auto, other gpu failures do not fall back", device: DeviceAuto, gpuMode: "nooutput", wantGPU: true, wantErr: "Upscaling failed"},
		{name: "gpu forced, no gpu", device: DeviceGPU, gpuMode: "gpuerr", wantGPU: true, wantErr: "No compatible GPU found"},
		{name: "cpu forced", device: DeviceCPU, wantCPU: true, wantDevice: "cpu"},
		{name: "cpu forced, no engine", device: DeviceCPU, noEngine: true, wantErr: "audio-engine isn't installed"},
	}
	for _, c := range tests {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			if c.big {
				writePNG(t, e.in, 2000, 1500, false)
			}
			e.sc.handle = fakeEngine(t)
			if c.noGPUDep {
				delete(e.rec.tools, deps.Upscayl)
			}
			if !c.noEngine {
				e.rec.tools[sidecar.DepID] = "/engine"
			}
			if c.gpuMode != "" {
				t.Setenv("FAKE_UPSCAYL_MODE", c.gpuMode)
			}
			err := e.run(t, Options{Model: ModelIllustration, Scale: 4, Format: FormatSame, Device: c.device})
			if c.wantErr != "" {
				var ae *core.AppError
				if !errors.As(err, &ae) || ae.Message != c.wantErr {
					t.Fatalf("err = %v, want %q", err, c.wantErr)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if gpu := len(e.invocations(t)) > 0; gpu != c.wantGPU {
				t.Errorf("gpu ran = %v, want %v", gpu, c.wantGPU)
			}
			cpu := false
			for _, m := range e.sc.methods() {
				cpu = cpu || m == "upscale.run"
			}
			if cpu != c.wantCPU {
				t.Errorf("cpu ran = %v, want %v", cpu, c.wantCPU)
			}
			if c.wantLog != "" && !e.rec.hasLog(c.wantLog) {
				t.Errorf("log %q missing: %v", c.wantLog, e.rec.logs)
			}
			if c.wantErr != "" {
				if l := leftovers(t, e.outDir); len(l) != 0 {
					t.Errorf("leftovers %v", l)
				}
				return
			}
			var res Result
			json.Unmarshal(e.rec.result, &res)
			if res.Device != c.wantDevice {
				t.Errorf("device %q, want %q", res.Device, c.wantDevice)
			}
			if c.wantDevice == "cpu" && !strings.HasSuffix(e.rec.lastMsg(), " · CPU") {
				t.Errorf("message %q", e.rec.lastMsg())
			}
			if l := leftovers(t, e.outDir); len(l) != 1 {
				t.Errorf("leftovers %v", l)
			}
		})
	}
}

func TestRunCPUParams(t *testing.T) {
	e := newEnv(t)
	e.sc.handle = fakeEngine(t)
	e.rec.tools[sidecar.DepID] = "/engine"
	err := e.run(t, Options{Model: ModelFast, Scale: 2, Format: FormatWebP, Device: DeviceCPU})
	if err != nil {
		t.Fatal(err)
	}
	p := e.sc.calls[0].Params
	cm := models[ModelFast].CPU
	mm, _ := p["model"].(map[string]any)
	if mm["file"] != cm.File || mm["sha256"] != cm.SHA256 || mm["url"] != cm.URL {
		t.Errorf("model %v", mm)
	}
	if p["modelDir"] != filepath.Join(e.m.modelsDir, "upscale") || p["scale"] != 2 || p["format"] != "webp" || p["input"] != e.in {
		t.Errorf("params %v", p)
	}
	if !strings.HasSuffix(p["output"].(string), ".tmp.webp") {
		t.Errorf("output %v", p["output"])
	}
	// The fake engine wrote a PNG named .webp; only the registration matters here.
	if len(e.rec.outputs) != 1 || filepath.Ext(e.rec.outputs[0]) != ".webp" {
		t.Errorf("outputs %v", e.rec.outputs)
	}
	if !e.rec.hasLog("tile 1/2") {
		t.Error("engine log not forwarded")
	}
	found := false
	for _, m := range e.rec.msgs {
		found = found || m == "Upscaling · 50%"
	}
	if !found {
		t.Errorf("engine progress not forwarded: %v", e.rec.msgs)
	}
}
