package videoeditor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

// TestMain turns the test binary into a fake ffmpeg/ffprobe when
// FAKE_FF_MODE is set (the re-exec pattern).
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_FF_MODE") == "1" {
		os.Exit(fakeFF())
	}
	os.Exit(m.Run())
}

const fakeProbe = `{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30/1","pix_fmt":"yuv420p"},{"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"48000"}],"format":{"format_name":"mov,mp4","start_time":"0.000000","duration":"30.000000","size":"1000"}}`

func fakeFF() int {
	args := os.Args[1:]
	for _, a := range args {
		if a == "-print_format" {
			fmt.Println(fakeProbe)
			return 0
		}
	}
	if p := os.Getenv("FAKE_FF_ARGSFILE"); p != "" {
		wd, _ := os.Getwd()
		f, _ := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		fmt.Fprintln(f, wd+"|"+strings.Join(args, " "))
		f.Close()
	}
	// The graph file must be readable from the working directory.
	for i, a := range args {
		if a == "-/filter_complex" {
			if _, err := os.Stat(args[i+1]); err != nil {
				fmt.Fprintln(os.Stderr, "no graph file")
				return 2
			}
		}
	}
	if os.Getenv("FAKE_FF_FAIL") == "1" {
		fmt.Fprintln(os.Stderr, "Invalid data found")
		return 1
	}
	fmt.Print("out_time_us=1000000\nspeed=2.0x\nprogress=continue\n")
	if os.Getenv("FAKE_FF_HANG") == "1" {
		time.Sleep(60 * time.Second)
	}
	fmt.Print("progress=end\n")
	return 0 | writeLast(args)
}

func writeLast(args []string) int {
	if err := os.WriteFile(args[len(args)-1], []byte("video"), 0o644); err != nil {
		return 3
	}
	return 0
}

type runRec struct {
	mu       sync.Mutex
	progress []float64
	outputs  []string
}

func (r *runRec) job(t *testing.T, o Options) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(o)
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Options: raw, OutputDir: filepath.Join(t.TempDir(), "Edits"), TempDir: filepath.Join(t.TempDir(), "tmp"),
	}, core.JobHooks{
		Progress: func(p float64, _ string) { r.mu.Lock(); r.progress = append(r.progress, p); r.mu.Unlock() },
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
			if id == "ffmpeg" || id == "ffprobe" {
				return os.Args[0], nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
}

// savedProject stores a one-clip project and returns its ID.
func savedProject(t *testing.T, m *Module, name string, titles bool) string {
	t.Helper()
	clip := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(clip, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewService(nil, m)
	info, err := svc.Create(name, "9:16")
	if err != nil {
		t.Fatal(err)
	}
	c := vclip("a", 0, 5000)
	c.Path = clip
	doc := VideoProject{Aspect: "9:16", Clips: []Clip{c}}
	if titles {
		doc.Titles = []Title{{ID: "t", Text: "Hello", StartMs: 0, DurationMs: 2000, Style: "caption", Position: "bottom", Color: "#ffffff"}}
	}
	if _, err := svc.Save(info.ID, name, doc); err != nil {
		t.Fatal(err)
	}
	return info.ID
}

func TestRunRender(t *testing.T) {
	t.Setenv("FAKE_FF_MODE", "1")
	args := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("FAKE_FF_ARGSFILE", args)
	m := newTestModule(t)
	id := savedProject(t, m, "My: trip?", true)
	var r runRec
	job := r.job(t, Options{Action: ActionRender, ProjectID: id})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 || filepath.Dir(r.outputs[0]) != job.OutputDir || filepath.Ext(r.outputs[0]) != ".mp4" {
		t.Fatalf("outputs = %v", r.outputs)
	}
	if _, err := os.Stat(r.outputs[0] + ".part"); err == nil {
		t.Error(".part left behind")
	}
	if len(r.progress) == 0 || r.progress[len(r.progress)-1] != 1 {
		t.Errorf("progress = %v", r.progress)
	}
	// FFmpeg ran in the TempDir with the graph and the titles there.
	b, _ := os.ReadFile(args)
	line := strings.TrimSpace(string(b))
	wd, _, _ := strings.Cut(line, "|")
	if wd != job.TempDir {
		t.Errorf("ffmpeg ran in %q, want the TempDir %q", wd, job.TempDir)
	}
	for _, f := range []string{graphName, assName} {
		if _, err := os.Stat(filepath.Join(job.TempDir, f)); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
	if !strings.Contains(line, "ass=") && !strings.Contains(line, "-/filter_complex graph.txt") {
		t.Errorf("args = %s", line)
	}
	g, _ := os.ReadFile(filepath.Join(job.TempDir, graphName))
	if !strings.Contains(string(g), "ass=titles.ass") {
		t.Errorf("graph lacks the titles: %s", g)
	}
	// A second render doesn't overwrite the first.
	job2 := r.job(t, Options{Action: ActionRender, ProjectID: id})
	job2.OutputDir = job.OutputDir
	if err := m.Run(context.Background(), job2); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 2 || r.outputs[0] == r.outputs[1] {
		t.Errorf("outputs = %v", r.outputs)
	}
}

func TestRunPreview(t *testing.T) {
	t.Setenv("FAKE_FF_MODE", "1")
	args := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("FAKE_FF_ARGSFILE", args)
	m := newTestModule(t)
	id := savedProject(t, m, "Trip", false)
	var r runRec
	if err := m.Run(context.Background(), r.job(t, Options{Action: ActionPreview, ProjectID: id})); err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 0 {
		t.Errorf("a preview is not a Library output: %v", r.outputs)
	}
	svc := NewService(nil, m)
	p := svc.PreviewPath(id)
	if p == "" || filepath.Base(p) != "preview.mp4" || filepath.Dir(p) != m.docs.Dir(id) {
		t.Fatalf("PreviewPath = %q", p)
	}
	b, _ := os.ReadFile(args)
	if !strings.Contains(string(b), "veryfast") || !strings.Contains(string(b), "-crf 28") {
		t.Errorf("preview settings missing: %s", b)
	}
	if _, err := os.Stat(filepath.Join(m.docs.Dir(id), "preview.tmp.mp4")); err == nil {
		t.Error("temp preview left behind")
	}
}

func TestRunFailureAndCancel(t *testing.T) {
	t.Setenv("FAKE_FF_MODE", "1")
	m := newTestModule(t)
	id := savedProject(t, m, "Trip", false)

	t.Setenv("FAKE_FF_FAIL", "1")
	var r runRec
	job := r.job(t, Options{Action: ActionRender, ProjectID: id})
	err := m.Run(context.Background(), job)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeToolFailed || ae.Hint != "Invalid data found" {
		t.Errorf("failure = %v", err)
	}
	if entries, _ := os.ReadDir(job.OutputDir); len(entries) != 0 {
		t.Errorf("a failed render left %d files", len(entries))
	}

	t.Setenv("FAKE_FF_FAIL", "")
	t.Setenv("FAKE_FF_HANG", "1")
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(700 * time.Millisecond); cancel() }()
	job = r.job(t, Options{Action: ActionRender, ProjectID: id})
	start := time.Now()
	if err := m.Run(ctx, job); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: %v", err)
	}
	if time.Since(start) > 20*time.Second {
		t.Error("cancel took too long")
	}
	if entries, _ := os.ReadDir(job.OutputDir); len(entries) != 0 {
		t.Errorf("a cancelled render left %d files", len(entries))
	}
}

func TestRenderProjectRejectsBadProjects(t *testing.T) {
	m := newTestModule(t)
	var r runRec
	job := r.job(t, Options{})
	if err := m.RenderProject(context.Background(), job, VideoProject{Aspect: "9:16"}, filepath.Join(t.TempDir(), "o.mp4"), RenderOptions{}); err == nil {
		t.Error("an empty project must not render")
	}
	c := vclip("a", 0, 3000)
	c.Path = filepath.Join(t.TempDir(), "gone.mp4")
	if err := m.RenderProject(context.Background(), job, VideoProject{Aspect: "9:16", Clips: []Clip{c}}, filepath.Join(t.TempDir(), "o.mp4"), RenderOptions{}); err == nil {
		t.Error("a missing file must not render")
	}
}
