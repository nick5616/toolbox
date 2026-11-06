package documents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
	"toolbox/core/deps"
)

// TestMain turns the test binary into a fake pandoc when FAKE_PANDOC_MODE is
// set (the re-exec pattern).
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_PANDOC_MODE") == "1" {
		os.Exit(fakePandoc())
	}
	os.Exit(m.Run())
}

func fakePandoc() int {
	args := os.Args[1:]
	if p := os.Getenv("FAKE_PANDOC_ARGSFILE"); p != "" {
		cwd, _ := os.Getwd()
		_ = os.WriteFile(p, []byte(cwd+"\n"+strings.Join(append(args, "TYPST="+os.Getenv("TYPST_PACKAGE_CACHE_PATH")), "\n")), 0o644)
	}
	code, _ := strconv.Atoi(os.Getenv("FAKE_PANDOC_EXIT"))
	if s := os.Getenv("FAKE_PANDOC_STDERR"); s != "" {
		fmt.Fprint(os.Stderr, strings.ReplaceAll(s, `\n`, "\n"))
	}
	if code != 0 {
		return code
	}
	_ = os.WriteFile("stray.tmp", []byte("stray"), 0o644)
	for i, a := range args {
		if a == "-o" && i+1 < len(args) {
			_ = os.WriteFile(args[i+1], []byte("converted"), 0o644)
		}
		if d, ok := strings.CutPrefix(a, "--extract-media="); ok {
			_ = os.MkdirAll(filepath.Join(d, "media"), 0o755)
			_ = os.WriteFile(filepath.Join(d, "media", "image1.png"), []byte("png"), 0o644)
		}
	}
	return 0
}

func optsTo(to Format) Options {
	o := DefaultOptions()
	o.To = to
	return o
}

func argValue(args []string, prefix string) (string, bool) {
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, prefix); ok {
			return v, true
		}
	}
	return "", false
}

func TestBuildArgs(t *testing.T) {
	md, _ := inputFormat(".md")
	in := runInfo{Input: filepath.Join(string(filepath.Separator), "docs", "a.md"), Output: "/t/result", DataDir: "/t/data", Typst: "/bin/typst", MetaFile: "/t/layout.yaml", MediaDir: "a_media", InputSpec: md}
	tests := []struct {
		name    string
		mod     func(*Options)
		to      Format
		has     []string
		hasNot  []string
		pairs   [][2]string // consecutive args
		hasPref []string
	}{
		{"docx basics", nil, FormatDOCX,
			[]string{"+RTS", "-M1024M", "-RTS", "-f", "markdown", "-t", "docx"}, []string{"-s", "--toc", "--embed-resources"}, nil,
			[]string{"--data-dir=/t/data", "--resource-path="}},
		{"docx reference doc", func(o *Options) { o.ReferenceDoc = "/s/ref.docx" }, FormatDOCX, nil, nil, nil, []string{"--reference-doc=/s/ref.docx"}},
		{"md ignores reference doc", func(o *Options) { o.ReferenceDoc = "/s/ref.docx" }, FormatMD, nil, nil, nil, nil},
		{"html embeds", nil, FormatHTML, []string{"-s", "--embed-resources"}, nil, nil, nil},
		{"html not embedded", func(o *Options) { o.EmbedResources = false }, FormatHTML, []string{"-s"}, []string{"--embed-resources"}, nil, nil},
		{"toc and numbers", func(o *Options) { o.TOC, o.NumberSections = true, true }, FormatEPUB, []string{"--toc", "--number-sections", "-t", "epub3"}, nil, nil, nil},
		{"pdf", func(o *Options) { o.PageSize = "letter"; o.MainFont = "Georgia"; o.FontSizePt = 12 }, FormatPDF,
			[]string{"papersize=us-letter", "fontsize=12pt", "mainfont=Georgia"}, []string{"-s"}, nil,
			[]string{"--pdf-engine=/bin/typst", "--metadata-file=/t/layout.yaml"}},
		{"pdf default font", nil, FormatPDF, []string{"papersize=a4", "fontsize=11pt"}, nil, nil, nil},
		{"typst", nil, FormatTypst, []string{"-s", "-t", "typst"}, nil, nil, []string{"--metadata-file="}},
		{"extract media md", func(o *Options) { o.ExtractMedia = true }, FormatMD, nil, nil, nil, []string{"--extract-media=a_media"}},
		{"extract media ignored for docx", func(o *Options) { o.ExtractMedia = true }, FormatDOCX, nil, nil, nil, nil},
		{"latex standalone", nil, FormatLaTeX, []string{"-s"}, nil, nil, nil},
		{"txt writer", nil, FormatTXT, []string{"plain"}, []string{"-s"}, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := optsTo(tt.to)
			if tt.mod != nil {
				tt.mod(&o)
			}
			args, err := buildArgs(o, in)
			if err != nil {
				t.Fatal(err)
			}
			for _, h := range tt.has {
				if !slices.Contains(args, h) {
					t.Errorf("missing %q in %v", h, args)
				}
			}
			for _, h := range tt.hasNot {
				if slices.Contains(args, h) {
					t.Errorf("unexpected %q in %v", h, args)
				}
			}
			for _, p := range tt.hasPref {
				if _, ok := argValue(args, p); !ok {
					t.Errorf("missing %q in %v", p, args)
				}
			}
			switch tt.name {
			case "md ignores reference doc":
				if _, ok := argValue(args, "--reference-doc="); ok {
					t.Error("md output must not get a reference doc")
				}
			case "extract media ignored for docx":
				if _, ok := argValue(args, "--extract-media="); ok {
					t.Error("docx output must not extract media")
				}
			}
			if tt.name == "typst" {
				if _, ok := argValue(args, "--pdf-engine="); ok {
					t.Error("typst output must not get a pdf engine")
				}
			}
			if args[len(args)-1] != in.Input || args[len(args)-3] != "-o" {
				t.Errorf("tail = %v", args[len(args)-3:])
			}
		})
	}
	if _, err := buildArgs(Options{To: "nope"}, in); err == nil {
		t.Error("unknown format should fail")
	}
}

func TestValidate(t *testing.T) {
	dir := t.TempDir()
	write := func(name string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	md, docx, pdf, pptx, png := write("a.md"), write("b.docx"), write("c.pdf"), write("d.pptx"), write("e.png")
	ref := write("ref.docx")
	m := &Module{}
	tests := []struct {
		name   string
		inputs []string
		mod    func(*Options)
		field  string // "" = valid
		msg    string
	}{
		{"ok", []string{md}, nil, "", ""},
		{"ok batch", []string{md, docx}, func(o *Options) { o.To = FormatPDF }, "", ""},
		{"pdf input", []string{pdf}, nil, "inputs.0", ocrHint},
		{"pptx input", []string{pptx}, nil, "inputs.0", ""},
		{"png input", []string{png}, nil, "inputs.0", ""},
		{"same format", []string{docx}, nil, "inputs.0", ""},
		{"md to gfm ok", []string{md}, func(o *Options) { o.To = FormatGFM }, "", ""},
		{"missing file", []string{filepath.Join(dir, "no.md")}, nil, "inputs.0", ""},
		{"no inputs", nil, nil, "inputs", ""},
		{"bad format", []string{md}, func(o *Options) { o.To = "nope" }, "to", ""},
		{"bad margin low", []string{md}, func(o *Options) { o.MarginMm = 9 }, "marginMm", ""},
		{"bad margin high", []string{md}, func(o *Options) { o.MarginMm = 51 }, "marginMm", ""},
		{"bad font size", []string{md}, func(o *Options) { o.FontSizePt = 17 }, "fontSizePt", ""},
		{"bad page size", []string{md}, func(o *Options) { o.PageSize = "a3" }, "pageSize", ""},
		{"bad font", []string{md}, func(o *Options) { o.MainFont = "Comic Papyrus" }, "mainFont", ""},
		{"good font", []string{md}, func(o *Options) { o.MainFont = "Georgia" }, "", ""},
		{"reference doc exists", []string{md}, func(o *Options) { o.ReferenceDoc = ref }, "", ""},
		{"reference doc missing", []string{md}, func(o *Options) { o.ReferenceDoc = filepath.Join(dir, "gone.docx") }, "referenceDoc", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := DefaultOptions()
			if tt.mod != nil {
				tt.mod(&o)
			}
			raw, _ := json.Marshal(o)
			err := m.Validate(tt.inputs, raw)
			if tt.field == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			ae := core.AsAppError(err)
			if ae == nil || ae.Code != core.CodeValidation {
				t.Fatalf("err = %v, want validation", err)
			}
			if _, ok := ae.Fields[tt.field]; !ok {
				t.Fatalf("fields = %v, want %s", ae.Fields, tt.field)
			}
			if tt.msg != "" && ae.Fields[tt.field] != tt.msg {
				t.Errorf("message = %q", ae.Fields[tt.field])
			}
		})
	}
	if err := m.Validate([]string{md}, json.RawMessage(`{"to":"docx","bogus":1}`)); err == nil {
		t.Error("unknown option field should fail")
	}
}

type recorder struct {
	mu      sync.Mutex
	outputs []string
	tools   []string
}

func (r *recorder) job(t *testing.T, input string, opts Options) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(opts)
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if _, err := os.Stat(p); err != nil {
				return core.Output{}, err
			}
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) {
			r.mu.Lock()
			r.tools = append(r.tools, id)
			r.mu.Unlock()
			if id == deps.Pandoc {
				return os.Args[0], nil
			}
			if id == deps.Typst {
				return filepath.Join("fake", "typst"), nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
}

func setFake(t *testing.T, stderr string, exit int) string {
	t.Helper()
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("FAKE_PANDOC_MODE", "1")
	t.Setenv("FAKE_PANDOC_ARGSFILE", argsFile)
	t.Setenv("FAKE_PANDOC_STDERR", stderr)
	t.Setenv("FAKE_PANDOC_EXIT", strconv.Itoa(exit))
	return argsFile
}

func sample(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("# Hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRunDocx(t *testing.T) {
	argsFile := setFake(t, "", 0)
	in := sample(t, "notes.md")
	r := &recorder{}
	job := r.job(t, in, optsTo(FormatDOCX))
	m := New("")
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(job.OutputDir, "notes.docx")
	if len(r.outputs) != 1 || r.outputs[0] != want {
		t.Fatalf("outputs = %v, want %s", r.outputs, want)
	}
	if b, _ := os.ReadFile(want); string(b) != "converted" {
		t.Errorf("output = %q", b)
	}
	// The stray file stayed in TempDir; the library only got the result.
	if _, err := os.Stat(filepath.Join(job.TempDir, "stray.tmp")); err != nil {
		t.Errorf("stray file should be in TempDir: %v", err)
	}
	entries, _ := os.ReadDir(job.OutputDir)
	if len(entries) != 1 {
		t.Errorf("output dir has %d entries", len(entries))
	}
	raw, _ := os.ReadFile(argsFile)
	lines := strings.Split(string(raw), "\n")
	if lines[0] != job.TempDir && !sameDir(t, lines[0], job.TempDir) {
		t.Errorf("cwd = %q, want %q", lines[0], job.TempDir)
	}
	args := lines[1:]
	data, _ := argValue(args, "--data-dir=")
	if filepath.Dir(data) != job.TempDir {
		t.Errorf("data-dir = %q, want under TempDir", data)
	}
	if st, err := os.Stat(data); err != nil || !st.IsDir() {
		t.Errorf("data dir should exist: %v", err)
	}
	if rp, _ := argValue(args, "--resource-path="); rp != filepath.Dir(in) {
		t.Errorf("resource-path = %q", rp)
	}
	if !slices.Contains(args, "-M1024M") {
		t.Errorf("no RTS limit: %v", args)
	}
	if slices.Contains(r.tools, deps.Typst) {
		t.Error("docx must not resolve typst")
	}
}

func sameDir(t *testing.T, a, b string) bool {
	t.Helper()
	ai, err1 := os.Stat(a)
	bi, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(ai, bi)
}

func TestRunPDFUsesTypst(t *testing.T) {
	argsFile := setFake(t, "", 0)
	in := sample(t, "paper.md")
	r := &recorder{}
	job := r.job(t, in, optsTo(FormatPDF))
	tools := t.TempDir()
	if err := New(tools).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(argsFile)
	args := strings.Split(string(raw), "\n")
	if v, _ := argValue(args, "--pdf-engine="); v != filepath.Join("fake", "typst") {
		t.Errorf("pdf-engine = %q", v)
	}
	wantCache := filepath.Join(tools, "typst", "packages")
	if v, _ := argValue(args, "TYPST="); v != wantCache {
		t.Errorf("TYPST_PACKAGE_CACHE_PATH = %q, want %q", v, wantCache)
	}
	if _, err := os.Stat(filepath.Join(job.TempDir, "layout.yaml")); err != nil {
		t.Errorf("layout metadata: %v", err)
	}
	if len(r.outputs) != 1 || filepath.Ext(r.outputs[0]) != ".pdf" {
		t.Errorf("outputs = %v", r.outputs)
	}
}

func TestRunNonClobbering(t *testing.T) {
	setFake(t, "", 0)
	in := sample(t, "notes.md")
	r := &recorder{}
	job := r.job(t, in, optsTo(FormatDOCX))
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(job.OutputDir, "notes.docx")
	if err := os.WriteFile(existing, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := New("").Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(existing); string(b) != "mine" {
		t.Error("existing output was overwritten")
	}
	if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "notes (1).docx" {
		t.Errorf("outputs = %v", r.outputs)
	}
}

func TestRunExtractMedia(t *testing.T) {
	setFake(t, "", 0)
	in := sample(t, "page.html")
	o := optsTo(FormatMD)
	o.ExtractMedia = true
	r := &recorder{}
	job := r.job(t, in, o)
	if err := New("").Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	img := filepath.Join(job.OutputDir, "page_media", "media", "image1.png")
	if _, err := os.Stat(img); err != nil {
		t.Errorf("extracted media not moved: %v", err)
	}
	if len(r.outputs) != 1 {
		t.Errorf("outputs = %v", r.outputs)
	}
}

func TestRunErrors(t *testing.T) {
	tests := []struct {
		name   string
		stderr string
		exit   int
		to     Format
		hint   string
		msg    string
	}{
		{"missing image", `[WARNING] x\n[ERROR] Could not fetch resource pic.png: file not found`, 99, FormatDOCX, "An image the document links to", "Could not fetch resource"},
		{"typst", `error: unknown variable: foo`, 43, FormatPDF, "PDF engine couldn't lay out", "unknown variable"},
		{"font", `error: unknown font family: Foo`, 1, FormatDOCX, "another main font", "unknown font family"},
		{"parse", `Error at "x" (line 1, column 1)`, 64, FormatDOCX, "damaged", "Error at"},
		{"plain", `boom`, 1, FormatDOCX, "", "boom"},
		{"silent", ``, 1, FormatDOCX, "", "couldn't convert"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setFake(t, tt.stderr, tt.exit)
			in := sample(t, "a.md")
			r := &recorder{}
			job := r.job(t, in, optsTo(tt.to))
			err := New("").Run(context.Background(), job)
			ae := core.AsAppError(err)
			if ae == nil || ae.Code != core.CodeToolFailed {
				t.Fatalf("err = %v", err)
			}
			if !strings.Contains(ae.Message, tt.msg) {
				t.Errorf("message = %q, want %q", ae.Message, tt.msg)
			}
			if tt.hint == "" && ae.Hint != "" || !strings.Contains(ae.Hint, tt.hint) {
				t.Errorf("hint = %q, want %q", ae.Hint, tt.hint)
			}
			if len(r.outputs) != 0 {
				t.Errorf("outputs on failure: %v", r.outputs)
			}
		})
	}
}

func TestRunCancelled(t *testing.T) {
	setFake(t, "", 0)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	in := sample(t, "a.md")
	r := &recorder{}
	err := New("").Run(ctx, r.job(t, in, optsTo(FormatDOCX)))
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want canceled", err)
	}
}

func TestRunMissingTool(t *testing.T) {
	in := sample(t, "a.md")
	job := core.NewJobContext(core.JobContext{
		Inputs: []string{in}, Options: json.RawMessage(`{"to":"docx"}`), OutputDir: t.TempDir(), TempDir: t.TempDir(),
	}, core.JobHooks{Tool: func(id string) (string, error) { return "", core.ErrDependencyMissing(id, "") }})
	err := New("").Run(context.Background(), job)
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("err = %v", err)
	}
}

func TestPickNames(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "a_media"), 0o755); err != nil {
		t.Fatal(err)
	}
	final, media := pickNames(dir, "a", ".md", true)
	if filepath.Base(final) != "a (1).md" || media != "a (1)_media" {
		t.Errorf("got %s %s", final, media)
	}
	final, media = pickNames(dir, "a", ".md", false)
	if filepath.Base(final) != "a.md" || media != "" {
		t.Errorf("got %s %s", final, media)
	}
}

func TestMapFailureMessageIsLastLine(t *testing.T) {
	e := mapFailure(1, []string{"first", "", "last line  ", ""}, FormatDOCX)
	if e.Message != "last line" {
		t.Errorf("message = %q", e.Message)
	}
}

func TestDescribeStep(t *testing.T) {
	m := &Module{}
	info, err := m.DescribeStep(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 1 || info.Produces[0].Role != "document" || !slices.Equal(info.Produces[0].Exts, []string{".docx"}) || info.Produces[0].Kind != core.KindDocument {
		t.Errorf("produces = %+v", info.Produces)
	}
	if len(info.Vars) != 1 || info.Vars[0].Name != "format" || len(info.Templates) != 0 {
		t.Errorf("vars/templates = %+v %+v", info.Vars, info.Templates)
	}
	if !slices.Contains(info.Accepts.Extensions, ".md") || slices.Contains(info.Accepts.Extensions, ".pdf") {
		t.Errorf("accepts = %v", info.Accepts.Extensions)
	}
	info, err = m.DescribeStep(json.RawMessage(`{"to":"pdf"}`))
	if err == nil {
		// partial options decode over defaults
		if info.Produces[0].Role != "pdf" || !slices.Equal(info.Produces[0].Exts, []string{".pdf"}) {
			t.Errorf("pdf produces = %+v", info.Produces)
		}
	} else {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"to":"nope"}`, `{"marginMm":5}`, `{"junk":1}`} {
		if _, err := m.DescribeStep(json.RawMessage(bad)); err == nil {
			t.Errorf("%s should fail", bad)
		}
	}
}

func TestPrepareStep(t *testing.T) {
	m := &Module{}
	a, b := sample(t, "a.md"), sample(t, "b.docx")
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"to":"epub"}`),
		Item:    core.StepItem{Files: []core.RunFile{{Path: a}, {Path: b}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, []string{a, b}) {
		t.Fatalf("jobs = %+v", jobs)
	}
	if o, ok := jobs[0].Options.(Options); !ok || o.To != FormatEPUB {
		t.Errorf("options = %+v", jobs[0].Options)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{}}); err == nil {
		t.Error("no files should fail")
	}
	pdf := sample(t, "x.pdf")
	_, err = m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: pdf}}}})
	if ae := core.AsAppError(err); ae == nil || ae.Message != ocrHint {
		t.Errorf("pdf input err = %v", err)
	}
}

func TestStepOutputs(t *testing.T) {
	m := &Module{}
	res, err := m.StepOutputs(core.Job{
		OptionsJSON: `{"to":"pdf"}`,
		Outputs:     []core.Output{{ID: "o1", Path: "/x/a.pdf", Name: "a.pdf", Kind: core.KindDocument}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Role != "pdf" || res.Files[0].OutputID != "o1" || res.Vars["format"] != "pdf" {
		t.Errorf("result = %+v", res)
	}
}

func TestDescriptor(t *testing.T) {
	d := (&Module{}).Descriptor()
	if d.ID != "documents" || d.OutputSubdir != "Documents" || !slices.Equal(d.Requires, []string{deps.Pandoc, deps.Typst}) || !slices.Equal(d.Parts, []string{"pdf"}) {
		t.Errorf("descriptor = %+v", d)
	}
	for _, ext := range []string{".docx", ".odt", ".rtf", ".epub", ".html", ".htm", ".md", ".markdown", ".tex", ".typ", ".ipynb", ".txt"} {
		if !slices.Contains(d.Accepts.Extensions, ext) {
			t.Errorf("should accept %s", ext)
		}
	}
}
