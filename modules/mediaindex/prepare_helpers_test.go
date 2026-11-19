package mediaindex

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"toolbox/core"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

const testDim = 4

// fakeWriter records what the jobs store.
type fakeWriter struct {
	mu          sync.Mutex
	needsOCR    func(vec []float32) bool
	transcripts map[string][]string
	maxMin      int
	batches     [][]ix.ItemResult
	speech      []ix.SpeechResult
	storeErr    error
}

func (f *fakeWriter) Model() ix.Model { return ix.Model{ID: "fake", Dim: testDim, Dir: "modeldir"} }
func (f *fakeWriter) NeedsOCR(v []float32) bool {
	return f.needsOCR != nil && f.needsOCR(v)
}
func (f *fakeWriter) StoreBatch(_ context.Context, r []ix.ItemResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches = append(f.batches, r)
	return f.storeErr
}
func (f *fakeWriter) StoreSpeech(_ context.Context, r ix.SpeechResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.speech = append(f.speech, r)
	return f.storeErr
}
func (f *fakeWriter) Current(context.Context, string) ([]ix.VectorAt, bool) { return nil, false }
func (f *fakeWriter) TextVector(context.Context, string) ([]float32, error) {
	return nil, nil
}
func (f *fakeWriter) Prob(_, _ []float32) float64               { return 0 }
func (f *fakeWriter) TextMatch(string, []core.MediaText) string { return "" }
func (f *fakeWriter) SpeechMaxMin() int                         { return f.maxMin }
func (f *fakeWriter) TranscriptsFor(_ context.Context, p string) ([]string, error) {
	return f.transcripts[p], nil
}

// fakeCaller dispatches engine calls to handlers and records them.
type fakeCaller struct {
	mu       sync.Mutex
	handlers map[string]func(params map[string]any) (any, error)
	calls    []call
}

type call struct {
	method string
	params map[string]any
}

func (f *fakeCaller) Call(_ context.Context, method string, params any, _ func(sidecar.Event)) (json.RawMessage, error) {
	b, _ := json.Marshal(params)
	var p map[string]any
	_ = json.Unmarshal(b, &p)
	f.mu.Lock()
	f.calls = append(f.calls, call{method, p})
	h := f.handlers[method]
	f.mu.Unlock()
	if h == nil {
		return nil, core.Errorf(core.CodeInternal, "no fake handler for %s", method)
	}
	res, err := h(p)
	if err != nil {
		return nil, err
	}
	return json.Marshal(res)
}

func (f *fakeCaller) named(method string) []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []call
	for _, c := range f.calls {
		if c.method == method {
			out = append(out, c)
		}
	}
	return out
}

func float32ToFP16(f float32) uint16 {
	b := math.Float32bits(f)
	sign := uint16(b>>16) & 0x8000
	exp := int32(b>>23) & 0xff
	frac := b & 0x7fffff
	switch {
	case exp == 0xff:
		if frac != 0 {
			return sign | 0x7e00
		}
		return sign | 0x7c00
	case exp > 127+15:
		return sign | 0x7c00
	case exp > 127-15: // normal
		h := uint32(exp-127+15)<<10 | frac>>13
		rem := frac & 0x1fff
		if rem > 0x1000 || (rem == 0x1000 && h&1 == 1) {
			h++
		}
		return sign | uint16(h)
	case exp >= 127-24: // subnormal
		frac |= 0x800000
		shift := uint32(127 - 14 - exp + 13)
		h := frac >> shift
		rem := frac & (1<<shift - 1)
		half := uint32(1) << (shift - 1)
		if rem > half || (rem == half && h&1 == 1) {
			h++
		}
		return sign | uint16(h)
	}
	return sign
}

func encodeVec(v []float32) string {
	raw := make([]byte, 0, len(v)*2)
	for _, f := range v {
		h := float32ToFP16(f)
		raw = append(raw, byte(h), byte(h>>8))
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// embedHandler answers search.embed_images: vector i is [1, i, 0, 0] unless
// path i is listed in fail (then ""). It also records each picture's size.
func embedHandler(t *testing.T, sizes *[]image.Point, fail map[int]bool) func(map[string]any) (any, error) {
	return func(p map[string]any) (any, error) {
		paths, _ := p["paths"].([]any)
		vecs := make([]string, len(paths))
		for i, a := range paths {
			path, _ := a.(string)
			f, err := os.Open(path)
			if err != nil {
				t.Errorf("embed path %q: %v", path, err)
				continue
			}
			cfg, err := jpeg.DecodeConfig(f)
			f.Close()
			if err != nil {
				t.Errorf("embed path %q isn't a JPEG: %v", path, err)
			}
			if sizes != nil {
				*sizes = append(*sizes, image.Pt(cfg.Width, cfg.Height))
			}
			if fail[i] {
				continue
			}
			vecs[i] = encodeVec([]float32{1, float32(i), 0, 0})
		}
		return map[string]any{"dim": testDim, "vectors": vecs}, nil
	}
}

// ocrHandler answers ocr.image like the engine: it writes "<base> (text).txt"
// into outputDir and returns its path. texts maps an input file name to the
// text it "reads" ("" = no lines).
func ocrHandler(t *testing.T, texts map[string]string) func(map[string]any) (any, error) {
	return func(p map[string]any) (any, error) {
		input, _ := p["input"].(string)
		dir, _ := p["outputDir"].(string)
		base, _ := p["baseName"].(string)
		txt := texts[filepath.Base(input)]
		if _, err := os.Stat(input); err != nil {
			t.Errorf("ocr input missing: %v", err)
		}
		if txt == "" {
			return map[string]any{"lines": 0, "characters": 0, "output": "", "preview": ""}, nil
		}
		out := filepath.Join(dir, base+" (text).txt")
		if err := os.WriteFile(out, []byte(txt+"\n"), 0o644); err != nil {
			return nil, err
		}
		return map[string]any{"lines": 2, "characters": len(txt), "output": out, "preview": txt}, nil
	}
}

// newJob builds a JobContext; tools lists dep IDs that fail to resolve.
func newJob(t *testing.T, inputs []string, opts any, missing map[string]bool) *core.JobContext {
	t.Helper()
	raw, err := json.Marshal(opts)
	if err != nil {
		t.Fatal(err)
	}
	return core.NewJobContext(core.JobContext{ID: "j1", Inputs: inputs, Options: raw, TempDir: t.TempDir()}, core.JobHooks{
		Tool: func(id string) (string, error) {
			if missing[id] {
				return "", core.ErrDependencyMissing(id, "")
			}
			return "/fake/" + id, nil
		},
	})
}

func newModules(w ix.Writer, c sidecar.Caller, pdf Renderer) (*IndexModule, *SpeechModule) {
	d := Deps{Writer: w, Caller: c, PDF: pdf, ModelsDir: "models"}
	return &IndexModule{d: d}, &SpeechModule{d: d}
}

func writeJPEGFile(t *testing.T, dir, name string, img image.Image) string {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// halves is a w×h picture, red on the left half and blue on the right.
func halves(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if x < w/2 {
				img.SetNRGBA(x, y, color.NRGBA{R: 255, A: 255})
			} else {
				img.SetNRGBA(x, y, color.NRGBA{B: 255, A: 255})
			}
		}
	}
	return img
}

// withExifOrientation inserts an APP1 Exif segment with orientation o after
// the SOI of a JPEG.
func withExifOrientation(jpg []byte, o byte) []byte {
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0}
	body := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, byte((len(body) + 2) >> 8), byte(len(body) + 2)}
	seg = append(seg, body...)
	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	return append(out, jpg[2:]...)
}
