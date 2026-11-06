package tts

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// TestMain turns the test binary into a fake ffmpeg when FAKE_FF_MODE is set
// (the re-exec pattern): it records its arguments and writes the last one.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_FF_MODE") == "1" {
		args := os.Args[1:]
		if p := os.Getenv("FAKE_FF_ARGSFILE"); p != "" {
			f, _ := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			_, _ = f.WriteString(strings.Join(args, "\x1f") + "\n")
			_ = f.Close()
		}
		if os.Getenv("FAKE_FF_FAIL") == "1" {
			os.Stderr.WriteString("Invalid data found\n")
			os.Exit(1)
		}
		_ = os.WriteFile(args[len(args)-1], []byte("encoded"), 0o644)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// fakeEngine writes wav stand-ins like tts.speak would.
type fakeEngine struct {
	calls  []map[string]any
	method []string
	titles []string // chapter titles to produce ("" = one plain file)
	err    error
}

func (f *fakeEngine) Call(_ context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	f.method = append(f.method, method)
	p, _ := params.(map[string]any)
	f.calls = append(f.calls, p)
	if f.err != nil {
		return nil, f.err
	}
	if method == "tts.prefetch" {
		return json.RawMessage(`{}`), nil
	}
	onEvent(sidecar.Event{Kind: "progress", Pct: 0.5, Msg: "Speaking"})
	dir, base := p["outputDir"].(string), p["baseName"].(string)
	_ = os.MkdirAll(dir, 0o755)
	res := engineResult{Voice: p["voice"].(string)}
	titles := f.titles
	if len(titles) == 0 || p["split"] == "none" {
		titles = []string{""}
	}
	for i, t := range titles {
		name := base + ".wav"
		if t != "" {
			name = base + " - 0" + string(rune('1'+i)) + " " + t + ".wav"
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("wav"), 0o644); err != nil {
			return nil, err
		}
		res.Files = append(res.Files, FileResult{Path: path, Title: t, Seconds: 30, Chapter: t != ""})
		res.Seconds += 30
	}
	b, _ := json.Marshal(res)
	return b, nil
}

type rec struct {
	outputs []string
	result  json.RawMessage
	title   string
	tools   map[string]error
	ffmpeg  string
}

func (r *rec) job(t *testing.T, input string, o Options) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(o)
	outDir := filepath.Join(t.TempDir(), "out")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return core.NewJobContext(core.JobContext{
		ID: "j1", Inputs: []string{input}, Options: raw,
		OutputDir: outDir, TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(float64, string) {},
		Log:      func(core.LogStream, string) {},
		Title:    func(s string) { r.title = s },
		Output: func(p string) (core.Output, error) {
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p, Name: filepath.Base(p)}, nil
		},
		Tool: func(id string) (string, error) {
			if err := r.tools[id]; err != nil {
				return "", err
			}
			if id == "ffmpeg" {
				return r.ffmpeg, nil
			}
			return "/engine", nil
		},
		Result: func(b json.RawMessage) { r.result = b },
	})
}

func write(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// installModels creates stand-ins for the pinned files.
func installModels(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "tts"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range kokoroFiles {
		if err := os.WriteFile(filepath.Join(dir, "tts", f.File), []byte("m"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func newModule(t *testing.T, eng *fakeEngine) *Module {
	t.Helper()
	return &Module{sc: eng, modelsDir: installModels(t), previewDir: filepath.Join(t.TempDir(), "prev"), textDir: filepath.Join(t.TempDir(), "text")}
}

func TestValidateOptions(t *testing.T) {
	txt := write(t, "a.txt", "hello")
	bad := write(t, "a.pdf", "x")
	m := &Module{}
	tests := []struct {
		name   string
		inputs []string
		opts   string
		field  string
	}{
		{"ok", []string{txt}, `{"voice":"af_heart","speed":1,"split":"none","format":"mp3"}`, ""},
		{"ok headings m4a", []string{txt}, `{"voice":"bm_george","speed":1.5,"split":"headings","format":"m4a"}`, ""},
		{"no inputs", nil, `{"voice":"af_heart","speed":1,"split":"none","format":"mp3"}`, "inputs"},
		{"bad file", []string{bad}, `{"voice":"af_heart","speed":1,"split":"none","format":"mp3"}`, "inputs.0"},
		{"unknown voice", []string{txt}, `{"voice":"nobody","speed":1,"split":"none","format":"mp3"}`, "voice"},
		{"speed low", []string{txt}, `{"voice":"af_heart","speed":0.4,"split":"none","format":"mp3"}`, "speed"},
		{"speed high", []string{txt}, `{"voice":"af_heart","speed":2.5,"split":"none","format":"mp3"}`, "speed"},
		{"split", []string{txt}, `{"voice":"af_heart","speed":1,"split":"paragraphs","format":"mp3"}`, "split"},
		{"format", []string{txt}, `{"voice":"af_heart","speed":1,"split":"none","format":"ogg"}`, "format"},
		{"unknown field", []string{txt}, `{"voice":"af_heart","speed":1,"split":"none","format":"mp3","x":1}`, "-"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.inputs, json.RawMessage(tc.opts))
			if tc.field == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !core.IsCode(err, core.CodeValidation) {
				t.Fatalf("want validation error, got %v", err)
			}
			if tc.field == "-" {
				return
			}
			var ae *core.AppError
			errors.As(err, &ae)
			if _, ok := ae.Fields[tc.field]; !ok {
				t.Fatalf("fields %v lack %q", ae.Fields, tc.field)
			}
		})
	}
}

func TestVoicesAreConsistent(t *testing.T) {
	seen := map[string]bool{}
	for _, v := range Voices() {
		if seen[v.ID] {
			t.Fatalf("duplicate voice %s", v.ID)
		}
		seen[v.ID] = true
		if v.Name == "" || v.Sample == "" || v.Group == "" {
			t.Errorf("voice %s is incomplete: %+v", v.ID, v)
		}
		switch v.Lang {
		case "en-us", "en-gb", "es", "fr-fr", "hi", "it", "pt-br":
		default:
			t.Errorf("voice %s has lang %q the engine doesn't take", v.ID, v.Lang)
		}
	}
	if !seen[DefaultVoice] {
		t.Fatal("the default voice isn't offered")
	}
}

func TestReadText(t *testing.T) {
	tests := []struct {
		name, file, in, want string
	}{
		{"txt crlf", "a.txt", "One.\r\nTwo.", "One.\nTwo."},
		{"txt bom", "a.txt", "\xEF\xBB\xBFHello", "Hello"},
		{"latin1", "a.txt", "caf\xe9", "café"},
		{"md passes through", "a.md", "# Title\n\n**bold** text", "# Title\n\n**bold** text"},
		{"srt", "a.srt", "1\n00:00:01,000 --> 00:00:03,000\n<i>Hello</i> there.\n\n2\n00:00:04,000 --> 00:00:06,000\n- How are you?\n{\\an8}Fine.\n", "Hello there. How are you? Fine."},
		{"vtt", "a.vtt", "WEBVTT\n\nNOTE a comment\n\nintro\n00:00.000 --> 00:02.000 align:start\nWelcome &amp; hello.\n\n00:03.000 --> 00:04.000\n♪ la la ♪\n", "Welcome & hello. la la"},
		{"html", "a.html", "<html><head><title>x</title><style>p{}</style></head><body><h1>Big &amp; Bold</h1><p>First <b>para</b>.</p><script>var a=1;</script><h2>Sub</h2><p>Second<br>line</p><ul><li>one</li><li>two</li></ul><!-- c --></body></html>",
			"# Big & Bold\n\nFirst para.\n\n## Sub\n\nSecond\nline\n\none\n\ntwo"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := readText(write(t, tc.file, tc.in))
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestReadTextTooLarge(t *testing.T) {
	p := filepath.Join(t.TempDir(), "big.txt")
	f, _ := os.Create(p)
	_ = f.Truncate(MaxTextBytes + 1)
	_ = f.Close()
	if _, err := readText(p); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("want validation error, got %v", err)
	}
}

func TestRunWav(t *testing.T) {
	eng := &fakeEngine{}
	m := newModule(t, eng)
	in := write(t, "Story.md", "# Hi\n\nSome words here.")
	r := &rec{}
	job := r.job(t, in, Options{Voice: "bm_george", Speed: 1.2, Split: SplitNone, Format: FormatWAV})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "Story.wav" || filepath.Dir(r.outputs[0]) != job.OutputDir {
		t.Fatalf("outputs = %v", r.outputs)
	}
	if _, err := os.Stat(r.outputs[0]); err != nil {
		t.Fatal(err)
	}
	p := eng.calls[0]
	if eng.method[0] != "tts.speak" || p["voice"] != "bm_george" || p["lang"] != "en-gb" || p["speed"] != 1.2 || p["split"] != "none" || p["baseName"] != "Story" {
		t.Fatalf("params = %v", p)
	}
	if !strings.HasSuffix(filepath.ToSlash(p["modelPath"].(string)), "tts/kokoro-v1.0.int8.onnx") || !strings.HasSuffix(filepath.ToSlash(p["voicesPath"].(string)), "tts/voices-v1.0.bin") {
		t.Fatalf("model paths = %v %v", p["modelPath"], p["voicesPath"])
	}
	if b, _ := os.ReadFile(p["input"].(string)); string(b) != "# Hi\n\nSome words here." {
		t.Fatalf("engine text = %q", b)
	}
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil || len(res.Files) != 1 || res.Files[0].Path != r.outputs[0] || res.Seconds != 30 {
		t.Fatalf("result = %s (%v)", r.result, err)
	}
	if r.title != "Story.md" {
		t.Fatalf("title = %q", r.title)
	}
}

func TestRunEncodesChapters(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("FAKE_FF_MODE", "1")
	t.Setenv("FAKE_FF_ARGSFILE", argsFile)
	eng := &fakeEngine{titles: []string{"Intro", "The Sea"}}
	m := newModule(t, eng)
	in := write(t, "Book.md", "# Intro\n\nA.\n\n# The Sea\n\nB.")
	r := &rec{ffmpeg: exe}
	job := r.job(t, in, Options{Voice: "af_heart", Speed: 1, Split: SplitHeadings, Format: FormatM4A})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 2 || filepath.Base(r.outputs[0]) != "Book - 01 Intro.m4a" || filepath.Base(r.outputs[1]) != "Book - 02 The Sea.m4a" {
		t.Fatalf("outputs = %v", r.outputs)
	}
	b, _ := os.ReadFile(argsFile)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 {
		t.Fatalf("ffmpeg ran %d times", len(lines))
	}
	args := strings.Split(lines[1], "\x1f")
	joined := strings.Join(args, " ")
	for _, want := range []string{"-c:a aac", "title=The Sea", "album=Book", "track=2/2", "-movflags +faststart"} {
		if !strings.Contains(joined, want) {
			t.Errorf("ffmpeg args lack %q: %s", want, joined)
		}
	}
	if eng.calls[0]["split"] != "headings" {
		t.Fatalf("split = %v", eng.calls[0]["split"])
	}
	var res Result
	_ = json.Unmarshal(r.result, &res)
	if len(res.Files) != 2 || !res.Files[1].Chapter || res.Files[1].Path != r.outputs[1] {
		t.Fatalf("result = %s", r.result)
	}
}

func TestRunMP3Args(t *testing.T) {
	args := encodeArgs(FormatMP3, "in.wav", "out.mp3", "T", "A", 1, 1)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "libmp3lame") || !strings.HasSuffix(joined, "out.mp3") {
		t.Fatal(joined)
	}
}

func TestRunFFmpegFailure(t *testing.T) {
	exe, _ := os.Executable()
	t.Setenv("FAKE_FF_MODE", "1")
	t.Setenv("FAKE_FF_FAIL", "1")
	m := newModule(t, &fakeEngine{})
	r := &rec{ffmpeg: exe}
	err := m.Run(context.Background(), r.job(t, write(t, "a.txt", "Hello world."), DefaultOptions()))
	if !core.IsCode(err, core.CodeToolFailed) {
		t.Fatalf("want tool_failed, got %v", err)
	}
	if len(r.outputs) != 0 {
		t.Fatalf("outputs = %v", r.outputs)
	}
}

func TestRunPreview(t *testing.T) {
	eng := &fakeEngine{}
	m := newModule(t, eng)
	r := &rec{}
	o := DefaultOptions()
	o.Preview = true
	if err := m.Run(context.Background(), r.job(t, write(t, "Hello.txt", "Hello."), o)); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 0 {
		t.Fatalf("a preview must not register outputs: %v", r.outputs)
	}
	var res Result
	_ = json.Unmarshal(r.result, &res)
	if res.PreviewPath == "" || filepath.Dir(res.PreviewPath) != m.previewDir || !strings.Contains(filepath.Base(res.PreviewPath), "preview-j1") {
		t.Fatalf("result = %s", r.result)
	}
}

func TestRunErrors(t *testing.T) {
	in := write(t, "a.txt", "Hello world.")
	t.Run("engine missing", func(t *testing.T) {
		m := newModule(t, &fakeEngine{})
		r := &rec{tools: map[string]error{"audio-engine": core.Errorf(core.CodeDependencyMissing, "no engine")}}
		if err := m.Run(context.Background(), r.job(t, in, DefaultOptions())); !core.IsCode(err, core.CodeDependencyMissing) {
			t.Fatal(err)
		}
	})
	t.Run("voices missing", func(t *testing.T) {
		eng := &fakeEngine{}
		m := &Module{sc: eng, modelsDir: t.TempDir()}
		r := &rec{}
		o := DefaultOptions()
		o.Format = FormatWAV
		err := m.Run(context.Background(), r.job(t, in, o))
		if !core.IsCode(err, core.CodeDependencyMissing) || len(eng.calls) != 0 {
			t.Fatalf("err = %v, calls = %d", err, len(eng.calls))
		}
	})
	t.Run("no text", func(t *testing.T) {
		m := newModule(t, &fakeEngine{})
		o := DefaultOptions()
		o.Format = FormatWAV
		r := &rec{}
		if err := m.Run(context.Background(), r.job(t, write(t, "e.html", "<html><script>x</script></html>"), o)); !core.IsCode(err, core.CodeValidation) {
			t.Fatal(err)
		}
	})
	t.Run("engine error", func(t *testing.T) {
		boom := core.Errorf(core.CodeToolFailed, "boom")
		m := newModule(t, &fakeEngine{err: boom})
		o := DefaultOptions()
		o.Format = FormatWAV
		r := &rec{}
		if err := m.Run(context.Background(), r.job(t, in, o)); !errors.Is(err, boom) {
			t.Fatal(err)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		m := newModule(t, &fakeEngine{})
		o := DefaultOptions()
		o.Format = FormatWAV
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		r := &rec{}
		if err := m.Run(ctx, r.job(t, in, o)); err == nil || len(r.outputs) != 0 {
			t.Fatalf("err = %v outputs = %v", err, r.outputs)
		}
	})
}

func TestModels(t *testing.T) {
	eng := &fakeEngine{}
	m := &Module{sc: eng, modelsDir: t.TempDir()}
	if m.ModelPresent(PresetKokoro) || m.ModelPresent("other") {
		t.Fatal("nothing is installed yet")
	}
	r := &rec{}
	job := r.job(t, "x", DefaultOptions())
	if err := m.FetchModel(context.Background(), job, "other"); !core.IsCode(err, core.CodeValidation) {
		t.Fatal(err)
	}
	if err := m.FetchModel(context.Background(), job, PresetKokoro); err != nil {
		t.Fatal(err)
	}
	if len(eng.calls) != 2 {
		t.Fatalf("prefetch calls = %d", len(eng.calls))
	}
	for i, c := range eng.calls {
		spec := c["model"].(map[string]any)
		if eng.method[i] != "tts.prefetch" || spec["file"] != kokoroFiles[i].File || spec["sha256"] != kokoroFiles[i].SHA256 || spec["url"] != kokoroFiles[i].URL {
			t.Fatalf("call %d = %v", i, c)
		}
		if !strings.HasSuffix(filepath.ToSlash(c["modelDir"].(string)), "/tts") {
			t.Fatalf("modelDir = %v", c["modelDir"])
		}
	}
	// With both files on disk it is a no-op and removal clears them.
	m2 := &Module{sc: eng, modelsDir: installModels(t)}
	if !m2.ModelPresent(PresetKokoro) {
		t.Fatal("expected present")
	}
	if err := m2.FetchModel(context.Background(), job, PresetKokoro); err != nil || len(eng.calls) != 2 {
		t.Fatalf("fetch of installed model made calls: %v", err)
	}
	if err := m2.RemoveModel(PresetKokoro); err != nil || m2.ModelPresent(PresetKokoro) {
		t.Fatalf("remove: %v", err)
	}
	if TotalModelBytes() != 92_361_271+28_214_398 {
		t.Fatalf("total = %d", TotalModelBytes())
	}
}

func TestPinsLookRight(t *testing.T) {
	for _, f := range kokoroFiles {
		if len(f.SHA256) != 64 || !strings.HasPrefix(f.URL, "https://") || f.Bytes <= 0 || strings.ContainsAny(f.File, `/\`) {
			t.Errorf("bad pin %+v", f)
		}
	}
}

func TestSlugAndWriteText(t *testing.T) {
	tests := map[string]string{
		"Hello, world. More text.\nSecond line": "Hello, world. More text",
		"   ":                                   "Pasted text",
		`a/b\c:d*e?"f"`:                         "a b c d e f",
		strings.Repeat("word ", 30):             strings.TrimSpace(strings.Repeat("word ", 8)),
	}
	for in, want := range tests {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
	m := &Module{textDir: t.TempDir()}
	p, err := m.writeText("Chapter one begins here")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "Chapter one begins here.txt" {
		t.Fatalf("path = %s", p)
	}
	if b, _ := os.ReadFile(p); string(b) != "Chapter one begins here" {
		t.Fatalf("content = %q", b)
	}
	p2, _ := m.writeText("Chapter one begins here")
	if p2 == p {
		t.Fatal("each paste needs its own folder")
	}
	if _, err := m.writeText(" \n "); !core.IsCode(err, core.CodeValidation) {
		t.Fatal(err)
	}
	if _, err := (&Module{}).writeText("x"); err == nil {
		t.Fatal("expected an error without a text dir")
	}
}

func TestPruneCache(t *testing.T) {
	m := &Module{previewDir: t.TempDir(), textDir: t.TempDir()}
	p := filepath.Join(m.previewDir, "preview-1.wav")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	m.PruneCache()
	if _, err := os.Stat(p); err != nil {
		t.Fatal("a fresh preview must survive PruneCache")
	}
	m.DiscardPreviews()
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("DiscardPreviews must delete previews")
	}
}

func TestPipelineStep(t *testing.T) {
	m := newModule(t, &fakeEngine{})
	if _, ok := any(m).(core.Chainable); !ok {
		t.Fatal("not chainable")
	}
	info, err := m.DescribeStep(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 1 || info.Produces[0].Role != "speech" || info.Produces[0].Exts[0] != ".mp3" || info.Produces[0].Kind != core.KindAudio {
		t.Fatalf("produces = %+v", info.Produces)
	}
	info, err = m.DescribeStep(json.RawMessage(`{"voice":"af_bella","split":"headings","format":"wav"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 2 || info.Produces[1].Role != "chapter" || !info.Produces[1].Many || info.Produces[1].Exts[0] != ".wav" {
		t.Fatalf("produces = %+v", info.Produces)
	}
	if !strings.Contains(info.Summary, "Bella") {
		t.Fatalf("summary = %q", info.Summary)
	}
	for _, bad := range []string{`{"voice":"zzz"}`, `{"speed":9}`, `{"format":"ogg"}`, `{"nope":1}`} {
		if _, err := m.DescribeStep(json.RawMessage(bad)); err == nil {
			t.Errorf("DescribeStep(%s) accepted", bad)
		}
	}

	txt := write(t, "a.txt", "Hi.")
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"speed":1.5}`),
		Item:    core.StepItem{Files: []core.RunFile{{Path: txt}}},
	})
	if err != nil || len(jobs) != 1 || len(jobs[0].Inputs) != 1 {
		t.Fatalf("jobs = %+v, %v", jobs, err)
	}
	if o, ok := jobs[0].Options.(Options); !ok || o.Speed != 1.5 || o.Preview || o.Voice != DefaultVoice {
		t.Fatalf("options = %+v", jobs[0].Options)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{}}); err == nil {
		t.Fatal("expected an error with no files")
	}
	pdf := write(t, "a.pdf", "x")
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: pdf}}}}); err == nil {
		t.Fatal("expected an error for an unsupported file")
	}

	res, err := m.StepOutputs(core.Job{
		OptionsJSON: `{"voice":"am_adam","speed":1,"split":"headings","format":"mp3"}`,
		ResultJSON:  `{"files":[{"path":"/o/b - 01 A.mp3","chapter":true},{"path":"/o/c.mp3","chapter":false}]}`,
		Outputs: []core.Output{
			{ID: "1", Path: "/o/b - 01 A.mp3", Name: "b - 01 A.mp3"},
			{ID: "2", Path: "/o/c.mp3", Name: "c.mp3"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 || res.Files[0].Role != "chapter" || res.Files[1].Role != "speech" || res.Files[0].OutputID != "1" || res.Vars["voice"] != "am_adam" {
		t.Fatalf("result = %+v", res)
	}
}

func TestDescriptor(t *testing.T) {
	d := (&Module{}).Descriptor()
	if d.ID != ModuleID || d.Status != core.StatusReady || d.NotAStep || !d.SplitInputs {
		t.Fatalf("descriptor = %+v", d)
	}
	reg := core.NewRegistry()
	if _, err := Register(reg, &fakeEngine{}, t.TempDir(), t.TempDir(), t.TempDir()); err != nil {
		t.Fatal(err)
	}
}
