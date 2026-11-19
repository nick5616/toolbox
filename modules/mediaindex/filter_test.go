package mediaindex

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

// fakeWriter implements ix.Writer (+ the optional Texts/Labels accessors).
type fakeWriter struct {
	model   ix.Model
	current map[string][]ix.VectorAt
	texts   map[string][]core.MediaText
	labels  map[string][]core.MediaLabel
}

func (f *fakeWriter) Model() ix.Model                                    { return f.model }
func (f *fakeWriter) NeedsOCR([]float32) bool                            { return false }
func (f *fakeWriter) StoreBatch(context.Context, []ix.ItemResult) error  { return nil }
func (f *fakeWriter) StoreSpeech(context.Context, ix.SpeechResult) error { return nil }
func (f *fakeWriter) TextVector(context.Context, string) ([]float32, error) {
	return []float32{1, 0}, nil
}
func (f *fakeWriter) TranscriptsFor(context.Context, string) ([]string, error) { return nil, nil }
func (f *fakeWriter) SpeechMaxMin() int                                        { return 60 }
func (f *fakeWriter) Current(_ context.Context, p string) ([]ix.VectorAt, bool) {
	v, ok := f.current[p]
	return v, ok
}
func (f *fakeWriter) Prob(t, v []float32) float64 { return float64(t[0]*v[0] + t[1]*v[1]) }
func (f *fakeWriter) TextMatch(q string, texts []core.MediaText) string {
	for _, t := range texts {
		if strings.Contains(strings.ToLower(t.Text), strings.ToLower(q)) {
			if t.Source == core.TextSourceOCR {
				return core.StrengthGood
			}
			return core.StrengthStrong
		}
	}
	return ""
}
func (f *fakeWriter) Texts(_ context.Context, p string) ([]core.MediaText, error) {
	return f.texts[p], nil
}
func (f *fakeWriter) Labels(_ context.Context, p string) ([]core.MediaLabel, error) {
	return f.labels[p], nil
}

// fakeCaller answers search.embed_images with probs[owner] as vector [p, 0],
// where owner is read from the prepared file name f<owner>.png.
type fakeCaller struct {
	probs  map[int]float32
	calls  int
	params map[string]any
}

func half(f float32) uint16 { // normal numbers only (enough for the tests)
	b := math.Float32bits(f)
	if f == 0 {
		return 0
	}
	exp := int((b>>23)&0xff) - 127 + 15
	return uint16(b>>31)<<15 | uint16(exp)<<10 | uint16((b>>13)&0x3ff)
}

func vecB64(a, b float32) string {
	buf := make([]byte, 4)
	binary.LittleEndian.PutUint16(buf, half(a))
	binary.LittleEndian.PutUint16(buf[2:], half(b))
	return base64.StdEncoding.EncodeToString(buf)
}

func (c *fakeCaller) Call(_ context.Context, method string, params any, _ func(sidecar.Event)) (json.RawMessage, error) {
	if method != "search.embed_images" {
		return nil, errors.New("unexpected " + method)
	}
	c.calls++
	c.params, _ = params.(map[string]any)
	paths, _ := c.params["paths"].([]string)
	vecs := make([]string, len(paths))
	for i, p := range paths {
		var owner int
		name := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
		for _, r := range strings.TrimPrefix(name, "f") {
			if r < '0' || r > '9' {
				break
			}
			owner = owner*10 + int(r-'0')
		}
		if pr, ok := c.probs[owner]; ok {
			vecs[i] = vecB64(pr, 0)
		}
	}
	return json.Marshal(map[string]any{"dim": 2, "vectors": vecs})
}

func writePic(t *testing.T, dir, name string) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for x := range 8 {
		img.Set(x, x, color.RGBA{200, 10, 10, 255})
	}
	p := filepath.Join(dir, name)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	return p
}

type env struct {
	m      *FilterModule
	w      *fakeWriter
	c      *fakeCaller
	dir    string
	result json.RawMessage
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	w := &fakeWriter{model: ix.Model{Dim: 2, Dir: filepath.Join(dir, "model")}, current: map[string][]ix.VectorAt{},
		texts: map[string][]core.MediaText{}, labels: map[string][]core.MediaLabel{}}
	c := &fakeCaller{probs: map[int]float32{}}
	return &env{m: &FilterModule{d: Deps{Writer: w, Caller: c}}, w: w, c: c, dir: dir}
}

func (e *env) installModel(t *testing.T) {
	t.Helper()
	p := filepath.Join(e.w.model.Dir, "visual")
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, "model.onnx"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (e *env) run(t *testing.T, o FilterOptions, inputs []string, toolErr error) (filterResult, error) {
	t.Helper()
	opts, _ := json.Marshal(o)
	tmp := filepath.Join(e.dir, "tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	e.result = nil
	job := core.NewJobContext(core.JobContext{ID: "j", Inputs: inputs, Options: opts, TempDir: tmp}, core.JobHooks{
		Tool:   func(string) (string, error) { return "tool", toolErr },
		Result: func(r json.RawMessage) { e.result = r },
	})
	err := e.m.Run(context.Background(), job)
	var res filterResult
	if e.result != nil {
		if jerr := json.Unmarshal(e.result, &res); jerr != nil {
			t.Fatal(jerr)
		}
	}
	return res, err
}

func names(paths []string) string {
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = filepath.Base(p)
	}
	return strings.Join(out, ",")
}

func TestFilterPictureStrengths(t *testing.T) {
	e := newEnv(t)
	a := writePic(t, e.dir, "a.png") // indexed: strong
	b := writePic(t, e.dir, "b.png") // computed: good
	c := writePic(t, e.dir, "c.png") // computed: maybe
	d := writePic(t, e.dir, "d.png") // computed: nothing
	e.w.current[a] = []ix.VectorAt{{Pos: -1, Vec: []float32{0.5, 0}}}
	e.c.probs = map[int]float32{1: 0.2, 2: 0.05, 3: 0.01}
	in := []string{a, b, c, d}

	for _, tc := range []struct {
		strength    FilterStrength
		kept, other string
	}{
		{FilterStrong, "a.png", "b.png,c.png,d.png"},
		{FilterGood, "a.png,b.png", "c.png,d.png"},
		{FilterMaybe, "a.png,b.png,c.png", "d.png"},
	} {
		res, err := e.run(t, FilterOptions{Query: "dog", Match: MatchPicture, Strength: tc.strength}, in, nil)
		if err != nil {
			t.Fatal(err)
		}
		if names(res.Kept) != tc.kept || names(res.Other) != tc.other || res.Matched != len(res.Kept) {
			t.Errorf("%s: kept %s other %s matched %d", tc.strength, names(res.Kept), names(res.Other), res.Matched)
		}
	}
	// the indexed file is never embedded again, and the engine got the model dir
	if e.c.calls == 0 {
		t.Fatal("no embed call")
	}
	if paths, _ := e.c.params["paths"].([]string); len(paths) != 3 {
		t.Errorf("embedded %v", paths)
	}
	if e.c.params["modelDir"] != e.w.model.Dir {
		t.Errorf("modelDir %v", e.c.params["modelDir"])
	}
	// inputs untouched
	if _, err := os.Stat(a); err != nil {
		t.Error(err)
	}
}

func TestFilterInvertAndBest(t *testing.T) {
	e := newEnv(t)
	a := writePic(t, e.dir, "a.png")
	b := writePic(t, e.dir, "b.png")
	e.w.current[a] = []ix.VectorAt{{Pos: -1, Vec: []float32{0.9, 0}}}
	e.w.current[b] = []ix.VectorAt{{Pos: -1, Vec: []float32{0.0, 0}}}
	e.w.labels[a] = []core.MediaLabel{
		{Label: "x", Display: "Hidden", Source: core.LabelHidden, Score: 0.99},
		{Label: "dog", Display: "Dog", Source: core.LabelAuto, Score: 0.8},
		{Label: "pet", Display: "Pet", Source: core.LabelAuto, Score: 0.6},
	}
	res, err := e.run(t, FilterOptions{Query: "dog", Match: MatchPicture, Strength: FilterGood}, []string{a, b}, nil)
	if err != nil || names(res.Kept) != "a.png" || res.Best != "Dog" {
		t.Fatalf("normal: %+v %v", res, err)
	}
	res, err = e.run(t, FilterOptions{Query: "dog", Match: MatchPicture, Strength: FilterGood, Invert: true}, []string{a, b}, nil)
	if err != nil || names(res.Kept) != "b.png" || names(res.Other) != "a.png" || res.Matched != 1 || res.Best != "" {
		t.Fatalf("invert: %+v %v", res, err)
	}
}

func TestFilterTextAndBoth(t *testing.T) {
	e := newEnv(t)
	a := writePic(t, e.dir, "a.png") // text only
	b := writePic(t, e.dir, "b.png") // picture only
	doc := filepath.Join(e.dir, "n.txt")
	if err := os.WriteFile(doc, []byte("receipt total"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.w.texts[a] = []core.MediaText{{Source: core.TextSourceOCR, Pos: -1, Text: "Receipt #42"}}
	e.w.current[b] = []ix.VectorAt{{Pos: -1, Vec: []float32{0.5, 0}}}
	e.w.current[a] = []ix.VectorAt{{Pos: -1, Vec: []float32{0, 0}}}
	in := []string{a, b}

	res, err := e.run(t, FilterOptions{Query: "receipt", Match: MatchText, Strength: FilterGood}, in, nil)
	if err != nil || names(res.Kept) != "a.png" {
		t.Fatalf("text: %+v %v", res, err)
	}
	if e.c.calls != 0 {
		t.Error("text mode must not embed")
	}
	res, err = e.run(t, FilterOptions{Query: "receipt", Match: MatchPicture, Strength: FilterGood}, in, nil)
	if err != nil || names(res.Kept) != "b.png" {
		t.Fatalf("picture: %+v %v", res, err)
	}
	res, err = e.run(t, FilterOptions{Query: "receipt", Match: MatchBoth, Strength: FilterGood}, in, nil)
	if err != nil || names(res.Kept) != "a.png,b.png" {
		t.Fatalf("both: %+v %v", res, err)
	}
	// strong needs a strong text match: OCR is "good" in the fake
	res, err = e.run(t, FilterOptions{Query: "receipt", Match: MatchText, Strength: FilterStrong}, in, nil)
	if err != nil || len(res.Kept) != 0 {
		t.Fatalf("strong text: %+v %v", res, err)
	}
}

func TestFilterEngineMissing(t *testing.T) {
	e := newEnv(t)
	a := writePic(t, e.dir, "a.png")
	_, err := e.run(t, FilterOptions{Query: "dog", Match: MatchBoth, Strength: FilterGood}, []string{a}, core.ErrDependencyMissing(sidecar.DepID, ""))
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("got %v", err)
	}
}

func TestFilterValidate(t *testing.T) {
	m := &FilterModule{}
	long := strings.Repeat("é", MaxQueryChars+1)
	for name, tc := range map[string]struct {
		opts   string
		inputs []string
		ok     bool
	}{
		"ok":          {`{"query":"dog","match":"both","strength":"good"}`, []string{"a"}, true},
		"defaults":    {`{"query":"dog"}`, []string{"a"}, true},
		"no query":    {`{"query":"  "}`, []string{"a"}, false},
		"too long":    {`{"query":"` + long + `"}`, []string{"a"}, false},
		"200 runes":   {`{"query":"` + strings.Repeat("é", MaxQueryChars) + `"}`, []string{"a"}, true},
		"bad match":   {`{"query":"x","match":"sound"}`, []string{"a"}, false},
		"bad level":   {`{"query":"x","strength":"sure"}`, []string{"a"}, false},
		"no inputs":   {`{"query":"x"}`, nil, false},
		"unknown key": {`{"query":"x","nope":1}`, []string{"a"}, false},
	} {
		err := m.Validate(tc.inputs, json.RawMessage(tc.opts))
		if (err == nil) != tc.ok {
			t.Errorf("%s: err %v", name, err)
		}
	}
}

func TestDecodeHalf(t *testing.T) {
	v, err := decodeHalf(vecB64(0.5, -2), 2)
	if err != nil || v[0] != 0.5 || v[1] != -2 {
		t.Fatalf("%v %v", v, err)
	}
	if _, err := decodeHalf(vecB64(1, 1), 3); err == nil {
		t.Error("dim mismatch must fail")
	}
}
