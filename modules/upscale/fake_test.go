package upscale

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/sidecar"
)

// TestMain turns the test binary into a fake upscayl-bin when FAKE_UPSCAYL=1
// (the re-exec pattern; the binary is copied to <install>/upscaler/upscayl-bin).
//
// Behaviour comes from FAKE_UPSCAYL_MODE:
//
//	ok        progress lines (\r\n on stderr), writes a valid output     (default)
//	gpuerr    prints "invalid gpu device (0)" and exits 1
//	gpuerr0   same message but exits 0 with no output
//	nooutput  exits 0 with no output and no message
//	crash     prints junk and exits 3
//	hang      writes a partial output, prints 0.00% and waits to be killed
//
// FAKE_UPSCAYL_DELAY (ms) delays the first progress line; FAKE_UPSCAYL_LOG
// receives every invocation's arguments (\x1f separated).
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_UPSCAYL") == "1" {
		os.Exit(fakeUpscayl())
	}
	code := m.Run()
	if fakeBin != "" {
		os.RemoveAll(filepath.Dir(fakeBin))
	}
	os.Exit(code)
}

func fakeUpscayl() int {
	args := os.Args[1:]
	arg := func(flag string) string {
		for i := 0; i+1 < len(args); i++ {
			if args[i] == flag {
				return args[i+1]
			}
		}
		return ""
	}
	if p := os.Getenv("FAKE_UPSCAYL_LOG"); p != "" {
		if f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			fmt.Fprintln(f, strings.Join(args, "\x1f"))
			f.Close()
		}
	}
	in, out := arg("-i"), arg("-o")
	if d, _ := strconv.Atoi(os.Getenv("FAKE_UPSCAYL_DELAY")); d > 0 {
		time.Sleep(time.Duration(d) * time.Millisecond)
	}
	switch os.Getenv("FAKE_UPSCAYL_MODE") {
	case "gpuerr":
		fmt.Fprint(os.Stderr, "[0 Fake] queueC=0\r\ninvalid gpu device\r\n")
		return 1
	case "gpuerr0":
		fmt.Fprint(os.Stderr, "vkCreateInstance failed -9\r\n")
		return 0
	case "nooutput":
		return 0
	case "crash":
		fmt.Fprint(os.Stderr, "l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\nboom\r\n")
		return 3
	case "hang":
		os.WriteFile(out, []byte("partial"), 0o644)
		fmt.Fprint(os.Stderr, "0.00%\r\n")
		time.Sleep(time.Minute)
		return 0
	}
	f, err := os.Open(in)
	if err != nil {
		return 0
	}
	cfg, _, err := image.DecodeConfig(f)
	f.Close()
	if err != nil {
		return 0
	}
	s, _ := strconv.Atoi(arg("-s"))
	fmt.Fprint(os.Stderr, "[0 Fake GPU] queueC=0\r\n0.00%\r\n")
	w, h := cfg.Width*s, cfg.Height*s
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 200
	}
	fmt.Fprint(os.Stderr, "50.00%\r\n")
	o, err := os.Create(out)
	if err != nil {
		return 1
	}
	switch strings.ToLower(filepath.Ext(out)) {
	case ".png":
		png.Encode(o, img)
	case ".jpg":
		jpeg.Encode(o, img, nil)
	default:
		o.WriteString("RIFFfakewebp")
	}
	o.Close()
	fmt.Fprint(os.Stderr, "100.00%\r\n")
	return 0
}

var (
	fakeOnce sync.Once
	fakeBin  string // a copy of the test binary named like upscayl-bin
)

// fakeInstall returns a fake upscaler install (binary + the five models).
func fakeInstall(t *testing.T) string {
	t.Helper()
	fakeOnce.Do(func() {
		dir, err := os.MkdirTemp("", "upscale-fake")
		if err != nil {
			t.Fatal(err)
		}
		fakeBin = filepath.Join(dir, exeName())
		copyFile(t, os.Args[0], fakeBin)
	})
	dir := filepath.Join(t.TempDir(), "upscaler")
	if err := os.MkdirAll(filepath.Join(dir, "models"), 0o755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, exeName())
	if err := os.Link(fakeBin, exe); err != nil {
		copyFile(t, fakeBin, exe)
	}
	for _, n := range deps.UpscaylModelNames {
		for _, e := range []string{".param", ".bin"} {
			os.WriteFile(filepath.Join(dir, "models", n+e), []byte("m"), 0o644)
		}
	}
	return exe
}

func exeName() string {
	if os.PathSeparator == '\\' {
		return "upscayl-bin.exe"
	}
	return "upscayl-bin"
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

// fakeCaller is a sidecar.Caller recording calls.
type fakeCaller struct {
	mu     sync.Mutex
	calls  []fakeCall
	handle func(ctx context.Context, method string, params map[string]any, onEvent func(sidecar.Event)) (any, error)
}

type fakeCall struct {
	Method string
	Params map[string]any
}

func (f *fakeCaller) Call(ctx context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	p, _ := params.(map[string]any)
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{method, p})
	h := f.handle
	f.mu.Unlock()
	if h == nil {
		return nil, fmt.Errorf("unexpected engine call %s", method)
	}
	res, err := h(ctx, method, p, onEvent)
	if err != nil {
		return nil, err
	}
	return json.Marshal(res)
}

func (f *fakeCaller) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		out = append(out, c.Method)
	}
	return out
}

// jobRec records what a job reports.
type jobRec struct {
	mu       sync.Mutex
	outputs  []string
	result   json.RawMessage
	msgs     []string
	pcts     []float64
	logs     []string
	tools    map[string]string // depID → path ("" = missing)
	toolErrs map[string]error
}

func (r *jobRec) job(t *testing.T, inputs []string, opts Options, outDir string) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(opts)
	return core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: inputs, Options: raw, OutputDir: outDir, TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(p float64, m string) {
			r.mu.Lock()
			r.msgs, r.pcts = append(r.msgs, m), append(r.pcts, p)
			r.mu.Unlock()
		},
		Log: func(_ core.LogStream, l string) { r.mu.Lock(); r.logs = append(r.logs, l); r.mu.Unlock() },
		Output: func(p string) (core.Output, error) {
			if _, err := os.Stat(p); err != nil {
				return core.Output{}, err
			}
			r.mu.Lock()
			r.outputs = append(r.outputs, p)
			r.mu.Unlock()
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) {
			if e := r.toolErrs[id]; e != nil {
				return "", e
			}
			if p := r.tools[id]; p != "" {
				return p, nil
			}
			return "", core.ErrDependencyMissing(id, "install "+id)
		},
		Result: func(b json.RawMessage) { r.mu.Lock(); r.result = b; r.mu.Unlock() },
	})
}

func (r *jobRec) lastMsg() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.msgs) == 0 {
		return ""
	}
	return r.msgs[len(r.msgs)-1]
}

func (r *jobRec) hasLog(sub string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, l := range r.logs {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

// writePNG writes a w×h PNG (NRGBA with a translucent pixel when alpha).
func writePNG(t *testing.T, path string, w, h int, alpha bool) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	if alpha {
		img.SetNRGBA(0, 0, color.NRGBA{10, 20, 30, 40})
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if alpha {
		err = png.Encode(f, img)
	} else {
		rgb := image.NewRGBA(img.Bounds())
		for i := range rgb.Pix {
			rgb.Pix[i] = 255
		}
		err = png.Encode(f, rgb)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func writeJPEG(t *testing.T, path string, w, h int) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := jpeg.Encode(f, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
}

// writeHugePNGHeader writes only a PNG signature + IHDR claiming w×h, enough
// for DecodeConfig.
func writeHugePNGHeader(t *testing.T, path string, w, h int) {
	t.Helper()
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:], uint32(h))
	ihdr[8], ihdr[9] = 8, 6 // 8-bit RGBA
	chunk := make([]byte, 0, 25)
	chunk = binary.BigEndian.AppendUint32(chunk, 13)
	chunk = append(chunk, "IHDR"...)
	chunk = append(chunk, ihdr...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
	data := append([]byte("\x89PNG\r\n\x1a\n"), chunk...)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
