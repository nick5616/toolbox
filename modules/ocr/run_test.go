package ocr

import (
	"context"
	"encoding/json"
	"errors"
	"image"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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
	// round-trip through JSON like the wire does
	b, _ := json.Marshal(params)
	f.params = map[string]any{}
	_ = json.Unmarshal(b, &f.params)
	for _, ev := range f.events {
		onEvent(ev)
	}
	if f.err != nil {
		return nil, f.err
	}
	return json.RawMessage(f.result), nil
}

type fakeRenderer struct {
	pages     int
	text      map[int]string
	countErr  error
	rendered  []int
	renderDPI int
	onRender  func(page int)
}

func (r *fakeRenderer) PageCount(context.Context, []byte, string) (int, error) {
	return r.pages, r.countErr
}

func (r *fakeRenderer) Render(_ context.Context, _ []byte, _ string, page, dpi int) (image.Image, error) {
	r.rendered = append(r.rendered, page)
	r.renderDPI = dpi
	if r.onRender != nil {
		r.onRender(page)
	}
	return image.NewRGBA(image.Rect(0, 0, 8, 8)), nil
}

func (r *fakeRenderer) PageText(_ context.Context, _ []byte, _ string, page int) (string, error) {
	return r.text[page], nil
}

type rec struct {
	title    string
	progress []string
	outputs  []string
	result   json.RawMessage
	toolErr  error
}

func (r *rec) hooks() core.JobHooks {
	return core.JobHooks{
		Progress: func(_ float64, m string) { r.progress = append(r.progress, m) },
		Log:      func(core.LogStream, string) {},
		Title:    func(t string) { r.title = t },
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool:   func(string) (string, error) { return "/engine", r.toolErr },
		Result: func(b json.RawMessage) { r.result = b },
	}
}

func write(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func newJob(t *testing.T, r *rec, input, opts string) *core.JobContext {
	t.Helper()
	return core.NewJobContext(core.JobContext{Inputs: []string{input}, Options: json.RawMessage(opts), OutputDir: t.TempDir(), TempDir: t.TempDir()}, r.hooks())
}

func TestValidate(t *testing.T) {
	img := write(t, "a.png", "x")
	pdf := write(t, "a.pdf", "%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R>>")
	enc := write(t, "e.pdf", "%PDF-1.7\ntrailer<</Root 1 0 R /Encrypt 5 0 R>>")
	txt := write(t, "a.txt", "x")
	m := &Module{}
	tests := []struct {
		name   string
		inputs []string
		opts   string
		want   string // substring of the error ("" = ok)
	}{
		{"defaults image", []string{img}, ``, ""},
		{"defaults pdf", []string{pdf}, `{}`, ""},
		{"all options", []string{img}, `{"language":"arabic","pdfOutput":"both","imageOutput":"json","skipText":false}`, ""},
		{"encrypted pdf", []string{enc}, `{"language":"latin","pdfOutput":"searchable","imageOutput":"text"}`, "Remove this PDF's password first (PDF Toolkit → Remove password)"},
		{"bad language", []string{img}, `{"language":"klingon","pdfOutput":"searchable","imageOutput":"text"}`, "Some options are invalid"},
		{"bad pdf output", []string{img}, `{"language":"latin","pdfOutput":"docx","imageOutput":"text"}`, "Some options are invalid"},
		{"bad image output", []string{img}, `{"language":"latin","pdfOutput":"text","imageOutput":"html"}`, "Some options are invalid"},
		{"unknown option", []string{img}, `{"nope":1}`, "nope"},
		{"wrong extension", []string{txt}, ``, "txt"},
		{"no inputs", nil, ``, "Add at least one file"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.inputs, json.RawMessage(tc.opts))
			if tc.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(errText(err), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if !core.IsCode(err, core.CodeValidation) {
				t.Fatalf("want a validation error, got %v", err)
			}
		})
	}
}

func TestLanguagesAndPresets(t *testing.T) {
	langs := Languages()
	if len(langs) != 7 || langs[0].ID != LangLatin || langs[0].DownloadBytes != 0 {
		t.Fatalf("languages = %+v", langs)
	}
	for _, l := range langs[1:] {
		p := presets[l.ID]
		if p.Det == nil || p.Rec == nil || l.DownloadBytes == 0 {
			t.Fatalf("%s missing models", l.ID)
		}
		for _, e := range []*modelEntry{p.Det, p.Rec} {
			if len(e.SHA256) != 64 || !strings.HasPrefix(e.URL, "https://") || !strings.HasSuffix(e.URL, e.File) {
				t.Fatalf("%s: bad entry %+v", l.ID, e)
			}
		}
	}
}

func TestRunImage(t *testing.T) {
	in := write(t, "photo.jpg", "x")
	fc := &fakeCaller{
		events: []sidecar.Event{{Kind: "progress", Pct: 0.5, Msg: "Reading text"}, {Kind: "output", Path: "/out/photo (text).txt"}},
		result: `{"lines":2,"characters":1234,"meanConfidence":0.97,"output":"/out/photo (text).txt","preview":"hello"}`,
	}
	m := &Module{sc: fc, pdf: &fakeRenderer{}, modelsDir: "/models"}
	r := &rec{}
	job := newJob(t, r, in, `{"language":"cyrillic","pdfOutput":"searchable","imageOutput":"json","skipText":true}`)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if fc.method != "ocr.image" || fc.params["output"] != "json" || fc.params["baseName"] != "photo" || fc.params["input"] != in {
		t.Fatalf("call = %s %v", fc.method, fc.params)
	}
	rec := fc.params["rec"].(map[string]any)
	if rec["file"] != "cyrillic_PP-OCRv5_rec_mobile.onnx" || fc.params["det"].(map[string]any)["file"] != "ch_PP-OCRv5_det_mobile.onnx" {
		t.Fatalf("models = %v", fc.params)
	}
	if got := filepath.ToSlash(fc.params["modelDir"].(string)); got != "/models/ocr" {
		t.Fatalf("modelDir = %q", got)
	}
	if !reflect.DeepEqual(r.outputs, []string{"/out/photo (text).txt"}) {
		t.Fatalf("outputs (registered once) = %v", r.outputs)
	}
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil {
		t.Fatal(err)
	}
	if res.Kind != "image" || res.Lines != 2 || res.Characters != 1234 || res.Preview != "hello" || len(res.Outputs) != 1 {
		t.Fatalf("result = %+v", res)
	}
	if last := r.progress[len(r.progress)-1]; last != "2 lines · 1,234 characters" {
		t.Fatalf("message = %q", last)
	}
}

func TestRunImageLatinUsesBundledModels(t *testing.T) {
	fc := &fakeCaller{result: `{"lines":0,"characters":0,"meanConfidence":0,"output":"","preview":""}`}
	m := &Module{sc: fc, modelsDir: "/m"}
	job := newJob(t, &rec{}, write(t, "a.png", "x"), ``)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if fc.params["det"] != nil || fc.params["rec"] != nil || fc.params["output"] != "text" {
		t.Fatalf("params = %v", fc.params)
	}
}

func TestRunPDFRendersSkipsAndSummarises(t *testing.T) {
	in := write(t, "scan.pdf", "%PDF-1.7")
	long := strings.Repeat("word ", 10) // 40 non-space characters
	rr := &fakeRenderer{pages: 4, text: map[int]string{2: long, 3: "  short \n"}}
	fc := &fakeCaller{
		events: []sidecar.Event{
			{Kind: "progress", Pct: 0.5, Msg: "Reading page 3 of 4"},
			{Kind: "output", Path: "/out/scan (searchable).pdf"},
		},
		result: `{"pages":4,"pagesOcred":3,"pagesSkipped":1,"characters":41203,"meanConfidence":0.98,"outputs":["/out/scan (searchable).pdf"]}`,
	}
	m := &Module{sc: fc, pdf: rr, modelsDir: t.TempDir()}
	r := &rec{}
	job := newJob(t, r, in, `{"language":"latin","pdfOutput":"searchable","imageOutput":"text","skipText":true}`)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rr.rendered, []int{1, 3, 4}) || rr.renderDPI != 200 {
		t.Fatalf("rendered %v at %d dpi", rr.rendered, rr.renderDPI)
	}
	for _, p := range []int{1, 3, 4} {
		if _, err := os.Stat(filepath.Join(job.TempDir, "pages", "p000"+string(rune('0'+p))+".png")); err != nil {
			t.Fatalf("page %d png: %v", p, err)
		}
	}
	if fc.method != "ocr.pdf" || fc.params["dpi"] != float64(200) || fc.params["pdfOutput"] != "searchable" {
		t.Fatalf("call = %s %v", fc.method, fc.params)
	}
	pages := fc.params["pages"].([]any)
	if len(pages) != 4 {
		t.Fatalf("pages = %v", pages)
	}
	p2 := pages[1].(map[string]any)
	p3 := pages[2].(map[string]any)
	if p2["skip"] != true || p2["page"] != float64(2) || p2["png"] != "" {
		t.Fatalf("page 2 = %v", p2)
	}
	if p3["skip"] != false || !strings.HasSuffix(filepath.ToSlash(p3["png"].(string)), "pages/p0003.png") {
		t.Fatalf("page 3 = %v", p3)
	}
	if !reflect.DeepEqual(r.outputs, []string{"/out/scan (searchable).pdf"}) {
		t.Fatalf("outputs = %v", r.outputs)
	}
	if last := r.progress[len(r.progress)-1]; last != "4 pages · 1 already had text · 41,203 characters" {
		t.Fatalf("message = %q", last)
	}
	if !contains(r.progress, "Rendering 3/4") {
		t.Fatalf("progress = %v", r.progress)
	}
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil || res.Kind != "pdf" || res.PagesSkipped != 1 {
		t.Fatalf("result = %+v (%v)", res, err)
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func TestRunPDFSkipTextOff(t *testing.T) {
	in := write(t, "scan.pdf", "%PDF-1.7")
	rr := &fakeRenderer{pages: 2, text: map[int]string{1: strings.Repeat("x", 100)}}
	fc := &fakeCaller{result: `{"pages":2,"pagesOcred":2,"pagesSkipped":0,"characters":5,"meanConfidence":1,"outputs":["a"]}`}
	m := &Module{sc: fc, pdf: rr, modelsDir: t.TempDir()}
	job := newJob(t, &rec{}, in, `{"language":"latin","pdfOutput":"both","imageOutput":"text","skipText":false}`)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rr.rendered, []int{1, 2}) || fc.params["pdfOutput"] != "both" {
		t.Fatalf("rendered %v params %v", rr.rendered, fc.params)
	}
}

func TestRunPDFEncrypted(t *testing.T) {
	in := write(t, "e.pdf", "%PDF-1.7 /Encrypt")
	m := &Module{sc: &fakeCaller{}, pdf: &fakeRenderer{}}
	err := m.Run(context.Background(), newJob(t, &rec{}, in, ``))
	if err == nil || !strings.Contains(err.Error(), "Remove this PDF's password first") {
		t.Fatalf("err = %v", err)
	}
	// pdfium reports a password requirement the byte scan can't see
	in2 := write(t, "e2.pdf", "%PDF-1.7")
	m2 := &Module{sc: &fakeCaller{}, pdf: &fakeRenderer{countErr: core.ValidationError("This PDF needs a password", nil)}}
	err = m2.Run(context.Background(), newJob(t, &rec{}, in2, ``))
	if err == nil || !strings.Contains(err.Error(), "Remove this PDF's password first") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunPDFCancelStopsRendering(t *testing.T) {
	in := write(t, "scan.pdf", "%PDF-1.7")
	ctx, cancel := context.WithCancel(context.Background())
	rr := &fakeRenderer{pages: 5, onRender: func(p int) {
		if p == 2 {
			cancel()
		}
	}}
	fc := &fakeCaller{}
	m := &Module{sc: fc, pdf: rr, modelsDir: t.TempDir()}
	err := m.Run(ctx, newJob(t, &rec{}, in, `{"language":"latin","pdfOutput":"searchable","imageOutput":"text","skipText":false}`))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if len(rr.rendered) != 2 || fc.calls != 0 {
		t.Fatalf("rendered %v, sidecar calls %d", rr.rendered, fc.calls)
	}
}

func TestRunErrors(t *testing.T) {
	in := write(t, "a.png", "x")
	// engine missing
	r := &rec{toolErr: core.ErrDependencyMissing(sidecar.DepID, "install it")}
	m := &Module{sc: &fakeCaller{}}
	if err := m.Run(context.Background(), newJob(t, r, in, ``)); !core.IsCode(err, core.CodeDependencyMissing) {
		t.Fatalf("err = %v", err)
	}
	// engine error is passed through
	boom := errors.New("boom")
	m = &Module{sc: &fakeCaller{err: boom}}
	if err := m.Run(context.Background(), newJob(t, &rec{}, in, ``)); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	// unreadable result
	m = &Module{sc: &fakeCaller{result: `nope`}}
	if err := m.Run(context.Background(), newJob(t, &rec{}, in, ``)); !core.IsCode(err, core.CodeInternal) {
		t.Fatalf("err = %v", err)
	}
}

func TestSummaries(t *testing.T) {
	if got := pdfSummary(Result{Pages: 1, Characters: 1}); got != "1 page · 1 character" {
		t.Fatal(got)
	}
	if got := groupInt(1234567); got != "1,234,567" {
		t.Fatal(got)
	}
}

func errText(err error) string {
	ae := core.AsAppError(err)
	s := err.Error() + " " + ae.Message
	for _, v := range ae.Fields {
		s += " " + v
	}
	return s
}
