//go:build integration

package upscale

import (
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/imaging"
)

// TestUpscaleIntegration installs the real pinned upscaler (network, ≈50 MB)
// into a temp bin dir, then upscales a generated 64×64 PNG on the GPU at 2×
// and 4× (plus WebP/JPEG output). It skips when there is no Vulkan GPU.
func TestUpscaleIntegration(t *testing.T) {
	t.Setenv("FAKE_UPSCAYL", "")
	if _, err := deps.UpscaylArchive().Parts[0].Asset(runtime.GOOS, runtime.GOARCH, ""); err != nil {
		t.Skipf("no upscaler build for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	root := t.TempDir()
	binDir := filepath.Join(root, "support", "bin")
	svc := deps.New(binDir, deps.Catalog(), core.NewRegistry(), core.NopEmitter{})
	var mu sync.Mutex
	var last string
	job := core.NewJobContext(core.JobContext{ID: "install", TempDir: filepath.Join(root, "tmp")}, core.JobHooks{
		Progress: func(_ float64, m string) { mu.Lock(); last = m; mu.Unlock() },
		Log:      func(_ core.LogStream, l string) { t.Log(l) },
	})
	start := time.Now()
	if err := svc.InstallManagedArchive(ctx, job, deps.UpscaylArchive()); err != nil {
		t.Fatalf("install: %v", err)
	}
	t.Logf("install took %s: %s", time.Since(start).Round(time.Millisecond), last)
	exe, err := svc.Resolve(deps.Upscayl)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(exe, filepath.Join(binDir, "upscaler")) {
		t.Errorf("resolved %q", exe)
	}
	if b, _ := os.ReadFile(filepath.Join(binDir, "upscaler", "VERSION")); strings.TrimSpace(string(b)) != deps.UpscaylVersion {
		t.Errorf("VERSION %q", b)
	}
	if runtime.GOOS == "windows" {
		if _, err := os.Stat(filepath.Join(binDir, "upscaler", "vcomp140.dll")); err != nil {
			t.Error(err)
		}
	}
	// A second install is a no-op.
	var again string
	job2 := core.NewJobContext(core.JobContext{ID: "install2", TempDir: filepath.Join(root, "tmp")}, core.JobHooks{
		Progress: func(_ float64, m string) { again = m },
	})
	if err := svc.InstallManagedArchive(ctx, job2, deps.UpscaylArchive()); err != nil || !strings.HasPrefix(again, "Already up to date") {
		t.Errorf("second install: %q %v", again, err)
	}

	work := filepath.Join(root, "Fotó Ünï 写真")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	in := filepath.Join(work, "gradient.png")
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for x := 0; x < 64; x++ {
		for y := 0; y < 64; y++ {
			img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 4), uint8((x ^ y) * 4), 255})
		}
	}
	f, err := os.Create(in)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()

	m := &Module{modelsDir: filepath.Join(root, "models")}
	run := func(o Options) (Result, string, error) {
		raw, _ := json.Marshal(o)
		var res Result
		var msg string
		outDir := filepath.Join(work, "Upscaled")
		j := core.NewJobContext(core.JobContext{ID: "x", ModuleID: ModuleID, Inputs: []string{in}, Options: raw,
			OutputDir: outDir, TempDir: t.TempDir()}, core.JobHooks{
			Progress: func(_ float64, m string) { msg = m },
			Log:      func(_ core.LogStream, l string) { t.Log(l) },
			Tool:     svc.Resolve,
			Output:   func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
			Result:   func(b json.RawMessage) { _ = json.Unmarshal(b, &res) },
		})
		if err := m.Validate([]string{in}, raw); err != nil {
			t.Fatalf("validate: %v", err)
		}
		t0 := time.Now()
		err := m.Run(ctx, j)
		t.Logf("%+v took %s -> %q", o, time.Since(t0).Round(time.Millisecond), msg)
		return res, msg, err
	}

	cases := []struct {
		o    Options
		w, h int
		ext  string
	}{
		{Options{Model: ModelFast, Scale: 2, Format: FormatSame, Device: DeviceGPU}, 128, 128, ".png"},
		{Options{Model: ModelPhoto, Scale: 4, Format: FormatSame, Device: DeviceGPU}, 256, 256, ".png"},
		{Options{Model: ModelIllustration, Scale: 2, Format: FormatWebP, Device: DeviceGPU}, 128, 128, ".webp"},
		{Options{Model: ModelFast, Scale: 4, Format: FormatJPG, Device: DeviceGPU}, 256, 256, ".jpg"},
	}
	for _, c := range cases {
		res, msg, err := run(c.o)
		var ae *core.AppError
		if errors.As(err, &ae) && ae.Message == noGPUMessage {
			t.Skip("no Vulkan GPU on this machine")
		}
		if err != nil {
			t.Fatalf("%+v: %v", c.o, err)
		}
		if res.OutWidth != c.w || res.OutHeight != c.h || res.InWidth != 64 || filepath.Ext(res.Output) != c.ext {
			t.Errorf("%+v: result %+v", c.o, res)
		}
		sz, err := imaging.Size(res.Output)
		if err != nil || sz.W != c.w || sz.H != c.h {
			t.Errorf("%+v: output size %v %v (want %dx%d)", c.o, sz, err, c.w, c.h)
		}
		if !strings.Contains(msg, "64×64 → ") {
			t.Errorf("message %q", msg)
		}
	}
	// The temp-named files are gone.
	ents, _ := os.ReadDir(filepath.Join(work, "Upscaled"))
	for _, e := range ents {
		if strings.Contains(e.Name(), ".tmp.") {
			t.Errorf("leftover %s", e.Name())
		}
	}
}
