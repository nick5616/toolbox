package captions

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/trash"
)

// TestMain turns the test binary into a fake exiftool / ffmpeg when
// FAKE_CAPTIONS_TOOL=1 (the re-exec pattern). The fake is exiftool when its
// arguments hold "-@", else ffmpeg. Every command is appended to
// FAKE_CAPTIONS_LOG (arguments joined with \x1f; for exiftool followed by the
// argument file's lines).
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_CAPTIONS_TOOL") == "1" {
		os.Exit(fakeTool(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func logLine(s string) {
	if p := os.Getenv("FAKE_CAPTIONS_LOG"); p != "" {
		f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintln(f, s)
			f.Close()
		}
	}
}

func fakeTool(args []string) int {
	last := ""
	if len(args) > 0 {
		last = args[len(args)-1]
	}
	for i, a := range args {
		if a == "-@" && i+1 < len(args) {
			body, _ := os.ReadFile(args[i+1])
			logLine("exiftool\x1f" + strings.Join(args, "\x1f") + "\n" + string(body))
			if s := os.Getenv("FAKE_CAPTIONS_FAIL"); s != "" && strings.Contains(last, s) {
				fmt.Fprintln(os.Stderr, "Error: Not a valid JPEG - "+last)
				fmt.Println("    0 image files updated")
				return 1
			}
			f, err := os.OpenFile(last, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				fmt.Fprintln(os.Stderr, "Error: File not found - "+last)
				return 1
			}
			f.WriteString("\nEXIFWRITTEN")
			f.Close()
			fmt.Println("    1 image files updated")
			return 0
		}
	}
	logLine("ffmpeg\x1f" + strings.Join(args, "\x1f"))
	has := func(a string) bool {
		for _, x := range args {
			if x == a {
				return true
			}
		}
		return false
	}
	if has("-frames:v") {
		_ = os.WriteFile(last, []byte("frame"), 0o644)
		return 0
	}
	in := ""
	for i, a := range args {
		if a == "-i" && i+1 < len(args) {
			in = args[i+1]
		}
	}
	if s := os.Getenv("FAKE_CAPTIONS_FAIL"); s != "" && strings.Contains(in, s) {
		fmt.Fprintln(os.Stderr, "Invalid data found when processing input")
		return 1
	}
	b, err := os.ReadFile(in)
	if err != nil {
		fmt.Fprintln(os.Stderr, "No such file")
		return 1
	}
	_ = os.WriteFile(last, append(b, []byte("\nFFMPEGWRITTEN")...), 0o644)
	return 0
}

// fakeVision is a scripted core.VisionGenerator.
type fakeVision struct {
	mu       sync.Mutex
	replies  []string // consumed in order; the last repeats
	fn       func(n int, req core.CompletionRequest) (string, error)
	calls    []core.CompletionRequest
	model    string
	visionEr error
}

func (f *fakeVision) Ready() (string, error)  { return f.model, nil }
func (f *fakeVision) ContextTokens() int      { return 4096 }
func (f *fakeVision) Vision() (string, error) { return f.model, f.visionEr }
func (f *fakeVision) Complete(ctx context.Context, req core.CompletionRequest) (string, error) {
	f.mu.Lock()
	n := len(f.calls)
	f.calls = append(f.calls, req)
	f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if f.fn != nil {
		return f.fn(n, req)
	}
	if len(f.replies) == 0 {
		return "", fmt.Errorf("no scripted reply")
	}
	return f.replies[min(n, len(f.replies)-1)], nil
}

func (f *fakeVision) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// good builds a JSON reply with every field.
func good(tag string) string {
	b, _ := json.Marshal(map[string]any{
		"alt": "Image of a " + tag + " on a table", "description": "A " + tag + " rests on a table. It is daytime.",
		"caption": "Look at this " + tag + " #" + tag, "hashtags": []string{"#love", "#" + tag, "#table", "#day", "#light", "#extra"},
		"title": "The " + tag + ".", "keywords": []string{tag, "Table", "man"}, "name": tag + " on table",
	})
	return string(b)
}

type fakeIndex struct {
	mu     sync.Mutex
	puts   map[string][]core.MediaText // path -> chunks
	order  []string
	labels []string
	text   string
	asked  []string
}

func (f *fakeIndex) PutText(_ context.Context, path, source string, chunks []core.MediaText) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.puts == nil {
		f.puts = map[string][]core.MediaText{}
	}
	if source != core.TextSourceCaption {
		return fmt.Errorf("source %q", source)
	}
	f.puts[path] = chunks
	f.order = append(f.order, path)
	return nil
}

func (f *fakeIndex) Hints(_ context.Context, path string, maxChars int) ([]string, string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, path)
	if f.labels == nil && f.text == "" {
		return nil, "", false
	}
	return f.labels, f.text, true
}

type emitted struct {
	mu   sync.Mutex
	list []ItemEvent
}

func (e *emitted) Emit(name string, data any) {
	if name != EventItem {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.list = append(e.list, data.(ItemEvent))
}

type env struct {
	t      *testing.T
	m      *Module
	lib    string
	vision *fakeVision
	index  *fakeIndex
	events *emitted
	trash  *trash.Fake
	tools  map[string]string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	lib := t.TempDir()
	e := &env{t: t, lib: lib, vision: &fakeVision{model: "test-vision"}, index: &fakeIndex{}, events: &emitted{}, trash: &trash.Fake{}}
	e.tools = map[string]string{deps.Llama: "llama-server"}
	e.m = New(Config{
		Vision: e.vision, Hints: e.index, Sink: e.index, Emitter: e.events,
		LibraryDir:      func() string { return lib },
		Resolve:         func(id string) (string, error) { return e.tools[id], toolErr(e.tools, id) },
		SearchInstalled: func() bool { return true },
	})
	e.m.trasher = e.trash
	e.m.probeDuration = func(context.Context, string, string) (int64, error) { return 60000, nil }
	return e
}

func toolErr(tools map[string]string, id string) error {
	if tools[id] == "" {
		return core.ErrDependencyMissing(id, "")
	}
	return nil
}

// useFakeTools points FFmpeg, FFprobe and ExifTool at this test binary.
func (e *env) useFakeTools() string {
	e.t.Helper()
	self, err := os.Executable()
	if err != nil {
		e.t.Fatal(err)
	}
	e.tools[deps.FFmpeg], e.tools[deps.FFprobe], e.tools[deps.ExifTool] = self, self, self
	e.t.Setenv("FAKE_CAPTIONS_TOOL", "1")
	logPath := filepath.Join(e.t.TempDir(), "fake.log")
	e.t.Setenv("FAKE_CAPTIONS_LOG", logPath)
	return logPath
}

type recorder struct {
	mu      sync.Mutex
	outputs []outRec
	logs    []string
	result  json.RawMessage
	title   string
}

type outRec struct {
	Path   string
	Inputs []string
}

func (e *env) job(inputs []string, o Options, rec *recorder) *core.JobContext {
	e.t.Helper()
	raw, err := json.Marshal(o)
	if err != nil {
		e.t.Fatal(err)
	}
	out := filepath.Join(e.lib, OutputSubdir)
	if err := os.MkdirAll(out, 0o755); err != nil {
		e.t.Fatal(err)
	}
	tmp := filepath.Join(e.t.TempDir(), "job")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		e.t.Fatal(err)
	}
	return core.NewJobContext(core.JobContext{ID: "job1", ModuleID: ModuleID, Inputs: inputs, Options: raw, OutputDir: out, TempDir: tmp}, core.JobHooks{
		Log:   func(_ core.LogStream, l string) { rec.mu.Lock(); rec.logs = append(rec.logs, l); rec.mu.Unlock() },
		Title: func(s string) { rec.title = s },
		OutputFrom: func(path string, in []string) (core.Output, error) {
			rec.mu.Lock()
			defer rec.mu.Unlock()
			rec.outputs = append(rec.outputs, outRec{path, in})
			return core.Output{Path: path, Name: filepath.Base(path)}, nil
		},
		Tool: func(id string) (string, error) {
			if p := e.tools[id]; p != "" {
				return p, nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
		Result: func(r json.RawMessage) { rec.result = r },
	})
}

func (r *recorder) hasOutput(base string) bool {
	for _, o := range r.outputs {
		if filepath.Base(o.Path) == base {
			return true
		}
	}
	return false
}

// photos writes n small JPEGs into a folder and returns their paths.
func photos(t *testing.T, dir string, names ...string) []string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var out []string
	for i, n := range names {
		img := image.NewRGBA(image.Rect(0, 0, 40+i, 30))
		for x := 0; x < 40; x++ {
			for y := 0; y < 30; y++ {
				img.Set(x, y, color.RGBA{uint8(x * 6), uint8(y * 8), uint8(i * 40), 255})
			}
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, nil); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func hashFiles(t *testing.T, paths []string) map[string][32]byte {
	t.Helper()
	out := map[string][32]byte{}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[p] = sha256.Sum256(b)
	}
	return out
}

func mustRun(t *testing.T, e *env, inputs []string, o Options) (*recorder, error) {
	t.Helper()
	rec := &recorder{}
	return rec, e.m.Run(context.Background(), e.job(inputs, o, rec))
}

func (r *recorder) batchDir(t *testing.T) string {
	t.Helper()
	var res result
	if err := json.Unmarshal(r.result, &res); err != nil {
		t.Fatalf("result: %v (%s)", err, r.result)
	}
	return res.BatchDir
}
