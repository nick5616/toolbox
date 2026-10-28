package pdf

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
	"toolbox/core/pdfium"
)

var (
	envBase   string // HOME/APPDATA/... point here for the whole package run
	pdfiumDir string // shared wazero cache so only one test pays the compile cost
)

// TestMain points every user/config dir at a temp dir and asserts at the end
// that pdfcpu never created its config dir there (SPEC §9).
func TestMain(m *testing.M) {
	base, err := os.MkdirTemp("", "toolbox-pdf-env-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	envBase = base
	for _, k := range []string{"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"} {
		os.Setenv(k, base)
	}
	code := m.Run()
	if entries, err := os.ReadDir(base); err != nil || len(entries) != 0 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		fmt.Fprintf(os.Stderr, "config dir leak: %s should be empty, found %v (err %v)\n", base, names, err)
		code = 1
	}
	_ = os.RemoveAll(base)
	if pdfiumDir != "" {
		_ = os.RemoveAll(pdfiumDir)
	}
	os.Exit(code)
}

// sharedCache returns one wazero cache dir for all renderer-using tests.
var cacheOnce sync.Once

func sharedCache(t *testing.T) string {
	t.Helper()
	cacheOnce.Do(func() { pdfiumDir, _ = os.MkdirTemp("", "toolbox-pdfium-cache-") })
	return pdfiumDir
}

// rec records what a job reports.
type rec struct {
	mu       sync.Mutex
	outputs  []string
	messages []string
	result   json.RawMessage
}

func (r *rec) hooks() core.JobHooks {
	return core.JobHooks{
		Progress: func(_ float64, msg string) {
			r.mu.Lock()
			r.messages = append(r.messages, msg)
			r.mu.Unlock()
		},
		Output: func(p string) (core.Output, error) {
			r.mu.Lock()
			r.outputs = append(r.outputs, p)
			r.mu.Unlock()
			return core.Output{Path: p}, nil
		},
		Result: func(b json.RawMessage) { r.result = b },
	}
}

func (r *rec) lastMessage() string {
	if len(r.messages) == 0 {
		return ""
	}
	return r.messages[len(r.messages)-1]
}

func (r *rec) res(t *testing.T) Result {
	t.Helper()
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil {
		t.Fatalf("result json %q: %v", r.result, err)
	}
	return res
}

func newTestModule(t *testing.T) *Module {
	t.Helper()
	r := pdfium.New(sharedCache(t))
	t.Cleanup(r.Close)
	return New(r)
}

// runJob runs an action directly through Module.Run, bypassing the manager.
func runJob(t *testing.T, m *Module, inputs []string, opts Options) (*rec, string, error) {
	t.Helper()
	return runJobCtx(t, context.Background(), m, inputs, opts)
}

func runJobCtx(t *testing.T, ctx context.Context, m *Module, inputs []string, opts Options) (*rec, string, error) {
	t.Helper()
	raw, err := json.Marshal(opts)
	if err != nil {
		t.Fatal(err)
	}
	r := &rec{}
	out := t.TempDir()
	job := core.NewJobContext(core.JobContext{
		ID: "job", ModuleID: ModuleID, Inputs: inputs, Options: raw, Attempt: 1,
		OutputDir: out, TempDir: t.TempDir(),
	}, r.hooks())
	return r, out, m.Run(ctx, job)
}

// opts returns default options for an action.
func opts(a Action) Options {
	o := DefaultOptions()
	o.Action = a
	return o
}

// writePDF writes a valid PDF with n pages of the given size, each with text.
func writePDF(t *testing.T, dir, name string, n int, w, h int) string {
	t.Helper()
	var buf bytes.Buffer
	var offsets []int
	obj := func(body string) {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	buf.WriteString("%PDF-1.4\n")
	// 1 catalog, 2 pages, 3 font, then per page: page + content.
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	var kids []string
	for i := range n {
		kids = append(kids, fmt.Sprintf("%d 0 R", 4+2*i))
	}
	obj(fmt.Sprintf("<< /Type /Pages /Count %d /Kids [%s] >>", n, strings.Join(kids, " ")))
	obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	for i := range n {
		obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents %d 0 R /Resources << /Font << /F1 3 0 R >> >> >>", w, h, 5+2*i))
		content := fmt.Sprintf("BT /F1 24 Tf 72 %d Td (%s page %d) Tj ET", h-100, strings.TrimSuffix(name, ".pdf"), i+1)
		obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
	}
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, o := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xref)
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// noisyJPEG writes a w×h colour-noise JPEG (hard to compress).
func noisyJPEG(t *testing.T, dir, name string, w, h, quality int) string {
	t.Helper()
	rng := rand.New(rand.NewSource(1))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = byte(rng.Intn(256)), byte(rng.Intn(256)), byte(rng.Intn(256)), 255
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// gradientPNG writes a w×h PNG.
func gradientPNG(t *testing.T, dir, name string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x * 255 / w), uint8(y * 255 / h), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func mustInfo(t *testing.T, m *Module, path, pw string) Info {
	t.Helper()
	in, err := m.info(context.Background(), path, pw)
	if err != nil {
		t.Fatalf("info(%s): %v", filepath.Base(path), err)
	}
	return in
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func isCode(err error, code core.ErrorCode) bool {
	ae := core.AsAppError(err)
	return ae != nil && ae.Code == code
}
