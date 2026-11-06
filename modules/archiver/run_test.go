package archiver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

// TestMain turns the test binary into a fake monolith or a fake browser when
// FAKE_ARCHIVER is set (the re-exec pattern). The browser is recognised by
// its --headless flag.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_ARCHIVER") == "1" {
		os.Exit(fakeTool())
	}
	os.Exit(m.Run())
}

func record(args []string) {
	if p := os.Getenv("FAKE_ARCHIVER_LOG"); p != "" {
		f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			cwd, _ := os.Getwd()
			fmt.Fprintf(f, "%s\t%s\n", cwd, strings.Join(args, "\x1f"))
			f.Close()
		}
	}
}

func fakeTool() int {
	args := os.Args[1:]
	record(args)
	failOn := os.Getenv("FAKE_ARCHIVER_FAIL") // substring of the url that makes the tool fail
	joined := strings.Join(args, " ")
	if failOn != "" && strings.Contains(joined, failOn) {
		fmt.Fprintln(os.Stderr, "boom: could not reach host")
		return 3
	}
	if strings.Contains(joined, "--headless") {
		for _, a := range args {
			if p, ok := strings.CutPrefix(a, "--print-to-pdf="); ok {
				if os.Getenv("FAKE_ARCHIVER_NOPDF") == "1" {
					return 0
				}
				_ = os.WriteFile(p, []byte("%PDF-1.4 fake"), 0o644)
				return 0
			}
		}
		fmt.Println("<html><head><title>Rendered &amp; Co</title></head>")
		fmt.Println()
		fmt.Println("<body>dom</body></html>")
		return 0
	}
	// monolith
	out := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-o" {
			out = args[i+1]
		}
	}
	title := "Fake Page"
	if os.Getenv("FAKE_ARCHIVER_NOTITLE") == "1" {
		title = ""
	}
	body := "<html><head>"
	if title != "" {
		body += "<title>" + title + "</title>"
	}
	body += "</head><body>" + args[0] + "</body></html>"
	if err := os.WriteFile(out, []byte(body), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	return 0
}

type rec struct {
	mu      sync.Mutex
	logs    []string
	titles  []string
	outputs []string
	result  json.RawMessage
	prog    []string
}

func (r *rec) job(t *testing.T, inputs []string, o Options) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(o)
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Inputs: inputs, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(p float64, m string) { r.mu.Lock(); r.prog = append(r.prog, m); r.mu.Unlock() },
		Log:      func(s core.LogStream, l string) { r.mu.Lock(); r.logs = append(r.logs, l); r.mu.Unlock() },
		Title:    func(s string) { r.mu.Lock(); r.titles = append(r.titles, s); r.mu.Unlock() },
		Result:   func(b json.RawMessage) { r.mu.Lock(); r.result = b; r.mu.Unlock() },
		Output: func(p string) (core.Output, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if _, err := os.Stat(p); err != nil {
				return core.Output{}, err
			}
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p, Name: filepath.Base(p)}, nil
		},
		Tool: func(id string) (string, error) {
			if id == "monolith" {
				return os.Args[0], nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
}

func fakeModule() *Module {
	m := New()
	m.browser = func() (string, string) { return os.Args[0], "Fake" }
	m.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}
	m.now = func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) }
	return m
}

func setFake(t *testing.T) string {
	t.Helper()
	logf := filepath.Join(t.TempDir(), "argv.log")
	t.Setenv("FAKE_ARCHIVER", "1")
	t.Setenv("FAKE_ARCHIVER_LOG", logf)
	return logf
}

func readLog(t *testing.T, p string) [][]string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var out [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		_, args, _ := strings.Cut(line, "\t")
		out = append(out, strings.Split(args, "\x1f"))
	}
	return out
}

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRunDefaultPath(t *testing.T) {
	logf := setFake(t)
	r := &rec{}
	job := r.job(t, []string{"https://Example.com/a/b"}, DefaultOptions())
	if err := fakeModule().Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 {
		t.Fatalf("outputs = %v", r.outputs)
	}
	want := filepath.Join(job.OutputDir, "example.com", "Fake Page 2026-11-04.html")
	if r.outputs[0] != want {
		t.Errorf("output = %s, want %s", r.outputs[0], want)
	}
	calls := readLog(t, logf)
	if len(calls) != 1 || calls[0][0] != "https://Example.com/a/b" || !contains(calls[0], "-M") {
		t.Errorf("monolith calls = %v", calls)
	}
	if len(r.titles) != 1 || r.titles[0] != "Fake Page" {
		t.Errorf("titles = %v", r.titles)
	}
	var sum Summary
	if err := json.Unmarshal(r.result, &sum); err != nil || len(sum.Results) != 1 || !sum.Results[0].OK {
		t.Errorf("summary = %s (%v)", r.result, err)
	}
	// The temp dir keeps the working copy; the output is a separate file.
	if _, err := os.Stat(want); err != nil {
		t.Error(err)
	}
}

func TestRunNeverOverwrites(t *testing.T) {
	setFake(t)
	r := &rec{}
	job := r.job(t, []string{"https://example.com/a", "https://example.com/b"}, DefaultOptions())
	if err := fakeModule().Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 2 || r.outputs[0] == r.outputs[1] {
		t.Fatalf("outputs = %v", r.outputs)
	}
	if filepath.Base(r.outputs[1]) != "Fake Page 2026-11-04 2.html" {
		t.Errorf("second = %s", r.outputs[1])
	}
}

func TestRunHostNameWithoutTitle(t *testing.T) {
	setFake(t)
	t.Setenv("FAKE_ARCHIVER_NOTITLE", "1")
	r := &rec{}
	job := r.job(t, []string{"https://example.com/"}, DefaultOptions())
	if err := fakeModule().Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if got := filepath.Base(r.outputs[0]); got != "example.com 2026-11-04.html" {
		t.Errorf("name = %s", got)
	}
}

func TestRunRenderJSAndPDF(t *testing.T) {
	logf := setFake(t)
	r := &rec{}
	o := DefaultOptions()
	o.RenderJS, o.AlsoPDF, o.NoJS = true, true, true
	job := r.job(t, []string{"https://example.com/x"}, o)
	if err := fakeModule().Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	calls := readLog(t, logf)
	if len(calls) != 3 {
		t.Fatalf("want dump-dom, monolith, pdf; got %v", calls)
	}
	if !contains(calls[0], "--dump-dom") {
		t.Errorf("first call = %v", calls[0])
	}
	if calls[1][0] != "dom.html" || !contains(calls[1], "-b") || !contains(calls[1], "-I") || !contains(calls[1], "-j") {
		t.Errorf("monolith call = %v", calls[1])
	}
	var pdfArg string
	for _, a := range calls[2] {
		if strings.HasPrefix(a, "--print-to-pdf=") {
			pdfArg = a
		}
	}
	if pdfArg == "" {
		t.Errorf("pdf call = %v", calls[2])
	}
	for _, c := range calls {
		for _, a := range c {
			if strings.Contains(a, "remote-debugging") {
				t.Errorf("remote debugging flag in %v", c)
			}
		}
		for _, a := range c {
			if strings.HasPrefix(a, "--user-data-dir=") && !strings.HasPrefix(a, "--user-data-dir="+job.TempDir) {
				t.Errorf("profile outside TempDir: %s", a)
			}
		}
	}
	if len(r.outputs) != 2 {
		t.Fatalf("outputs = %v", r.outputs)
	}
	// Title comes from the rendered page: the fake monolith ignores the DOM,
	// so the page keeps "Fake Page"; the pdf shares the page's stem.
	if strings.TrimSuffix(filepath.Base(r.outputs[0]), ".html") != strings.TrimSuffix(filepath.Base(r.outputs[1]), ".pdf") {
		t.Errorf("stems differ: %v", r.outputs)
	}
	dom, err := os.ReadFile(filepath.Join(job.TempDir, "0", "dom.html"))
	if err != nil || !strings.Contains(string(dom), "Rendered &amp; Co") {
		t.Errorf("dom file = %q (%v)", dom, err)
	}
}

func TestRunPDFFailureKeepsPage(t *testing.T) {
	setFake(t)
	t.Setenv("FAKE_ARCHIVER_NOPDF", "1")
	r := &rec{}
	o := DefaultOptions()
	o.AlsoPDF = true
	job := r.job(t, []string{"https://example.com/x"}, o)
	if err := fakeModule().Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 {
		t.Fatalf("outputs = %v", r.outputs)
	}
	var sum Summary
	_ = json.Unmarshal(r.result, &sum)
	if sum.Results[0].PDFErr == "" || sum.Results[0].PDF != "" {
		t.Errorf("result = %+v", sum.Results[0])
	}
}

func TestRunPartialAndTotalFailure(t *testing.T) {
	setFake(t)
	t.Setenv("FAKE_ARCHIVER_FAIL", "bad")

	r := &rec{}
	job := r.job(t, []string{"https://example.com/ok", "https://example.com/bad", "https://example.org/ok"}, DefaultOptions())
	if err := fakeModule().Run(context.Background(), job); err != nil {
		t.Fatalf("partial failure must not fail the job: %v", err)
	}
	if len(r.outputs) != 2 {
		t.Errorf("outputs = %v", r.outputs)
	}
	var sum Summary
	_ = json.Unmarshal(r.result, &sum)
	if len(sum.Results) != 3 || sum.Results[1].OK || sum.Results[1].Error == "" || !sum.Results[2].OK {
		t.Errorf("summary = %+v", sum)
	}

	r = &rec{}
	job = r.job(t, []string{"https://example.com/bad1", "https://example.com/bad2"}, DefaultOptions())
	err := fakeModule().Run(context.Background(), job)
	ae := core.AsAppError(err)
	if ae == nil || ae.Code != core.CodeToolFailed {
		t.Fatalf("all failed: %v", err)
	}

	r = &rec{}
	job = r.job(t, []string{"https://example.com/bad"}, DefaultOptions())
	err = fakeModule().Run(context.Background(), job)
	if ae := core.AsAppError(err); ae == nil || !strings.Contains(ae.Message, "boom") {
		t.Fatalf("single failure should carry the tool message: %v", err)
	}
}

func TestRunRefusesLocalAddresses(t *testing.T) {
	logf := setFake(t)
	m := fakeModule()
	m.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("192.168.0.9")}, nil
	}
	r := &rec{}
	job := r.job(t, []string{"https://sneaky.example/"}, DefaultOptions())
	if err := m.Run(context.Background(), job); err == nil {
		t.Fatal("want refusal")
	}
	if _, err := os.Stat(logf); err == nil {
		t.Error("monolith ran for a private address")
	}
	// The literal is also refused at Run (defence in depth).
	r = &rec{}
	job = r.job(t, []string{"http://127.0.0.1/"}, DefaultOptions())
	if err := m.Run(context.Background(), job); err == nil {
		t.Fatal("want refusal for literal")
	}
	// AllowLocal passes.
	o := DefaultOptions()
	o.AllowLocal = true
	r = &rec{}
	job = r.job(t, []string{"https://sneaky.example/"}, o)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatalf("allow local: %v", err)
	}
}

func TestRunCancel(t *testing.T) {
	setFake(t)
	r := &rec{}
	job := r.job(t, []string{"https://example.com/a"}, DefaultOptions())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fakeModule().Run(ctx, job); err == nil {
		t.Fatal("want cancellation error")
	}
	if len(r.outputs) != 0 {
		t.Errorf("outputs = %v", r.outputs)
	}
}

func TestRunNoBrowser(t *testing.T) {
	setFake(t)
	m := fakeModule()
	m.browser = func() (string, string) { return "", "" }
	o := DefaultOptions()
	o.RenderJS = true
	r := &rec{}
	err := m.Run(context.Background(), r.job(t, []string{"https://example.com/"}, o))
	if ae := core.AsAppError(err); ae == nil || ae.Hint == "" {
		t.Fatalf("want hinted error, got %v", err)
	}
}
