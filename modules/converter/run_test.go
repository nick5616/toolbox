package converter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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

func fakeFF() int {
	args := os.Args[1:]
	if p := os.Getenv("FAKE_FF_ARGSFILE"); p != "" && !isProbe(args) {
		_ = os.WriteFile(p, []byte(strings.Join(args, "\n")), 0o644)
	}
	if isProbe(args) {
		if d := os.Getenv("FAKE_FF_DURATION"); d != "" {
			fmt.Println(d)
		}
		code, _ := strconv.Atoi(os.Getenv("FAKE_FF_PROBE_EXIT"))
		return code
	}
	code, _ := strconv.Atoi(os.Getenv("FAKE_FF_EXIT"))
	fmt.Print(strings.ReplaceAll(os.Getenv("FAKE_FF_STDOUT"), `\n`, "\n"))
	if s := os.Getenv("FAKE_FF_STDERR"); s != "" {
		fmt.Fprint(os.Stderr, strings.ReplaceAll(s, `\n`, "\n"))
	}
	if code == 0 {
		_ = os.WriteFile(args[len(args)-1], []byte("converted"), 0o644)
	}
	if os.Getenv("FAKE_FF_HANG") == "1" {
		time.Sleep(60 * time.Second)
	}
	return code
}

func isProbe(args []string) bool {
	for _, a := range args {
		if a == "-show_entries" {
			return true
		}
	}
	return false
}

type recorder struct {
	mu       sync.Mutex
	progress []float64
	msgs     []string
	stderr   []string
	titles   []string
	outputs  []string
}

func (r *recorder) job(t *testing.T, input string, opts Options) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(opts)
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(p float64, m string) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.progress, r.msgs = append(r.progress, p), append(r.msgs, m)
		},
		Log: func(s core.LogStream, l string) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if s == core.StreamStderr {
				r.stderr = append(r.stderr, l)
			}
		},
		Title: func(s string) { r.mu.Lock(); r.titles = append(r.titles, s); r.mu.Unlock() },
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
			if id == "ffmpeg" || id == "ffprobe" {
				return os.Args[0], nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
}

func setFake(t *testing.T, stdout, stderr string, exit int) {
	t.Helper()
	t.Setenv("FAKE_FF_MODE", "1")
	t.Setenv("FAKE_FF_DURATION", "100.0")
	t.Setenv("FAKE_FF_STDOUT", stdout)
	t.Setenv("FAKE_FF_STDERR", stderr)
	t.Setenv("FAKE_FF_EXIT", strconv.Itoa(exit))
}

const goodProgress = `out_time_us=50000000\nspeed=2.0x\nprogress=continue\nout_time_us=100000000\nspeed=2.0x\nprogress=end\n`

func TestRunSuccessAndCollision(t *testing.T) {
	setFake(t, goodProgress, "", 0)
	input := touch(t, "Song.wav")
	var r recorder
	job := r.job(t, input, Options{Preset: "mp3-320", MaxHeight: HeightKeep, KeepMetadata: true})
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Pre-existing output forces the " (1)" suffix.
	if err := os.WriteFile(filepath.Join(job.OutputDir, "Song.mp3"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(job.OutputDir, "Song (1).mp3")
	if len(r.outputs) != 1 || r.outputs[0] != want {
		t.Fatalf("outputs = %v, want %s", r.outputs, want)
	}
	if b, _ := os.ReadFile(want); string(b) != "converted" {
		t.Errorf("content = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(job.OutputDir, "Song.mp3")); string(b) != "old" {
		t.Error("existing output was overwritten")
	}
	if _, err := os.Stat(filepath.Join(job.TempDir, "out.mp3")); !os.IsNotExist(err) {
		t.Error("temp output not moved")
	}
	if len(r.titles) != 1 || r.titles[0] != "Song.wav" {
		t.Errorf("titles = %v", r.titles)
	}
	if !contains(r.msgs, "Converting · 2.0× · ETA 0:25") {
		t.Errorf("msgs = %q", r.msgs)
	}
	if last := r.progress[len(r.progress)-1]; last != 1 || r.msgs[len(r.msgs)-1] != "Saved Song (1).mp3" {
		t.Errorf("last progress = %v %q", last, r.msgs[len(r.msgs)-1])
	}
	for _, p := range r.progress {
		if p > 0.99 && p != 1 {
			t.Errorf("progress %v", p)
		}
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

func TestRunArgsAndImageIndeterminate(t *testing.T) {
	setFake(t, `progress=end\n`, "", 0)
	argsFile := filepath.Join(t.TempDir(), "args")
	t.Setenv("FAKE_FF_ARGSFILE", argsFile)
	input := touch(t, "pic.jpg")
	var r recorder
	job := r.job(t, input, Options{Preset: "webp", MaxHeight: HeightKeep})
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(argsFile)
	args := strings.Split(string(b), "\n")
	if args[4] != input || args[len(args)-1] != filepath.Join(job.TempDir, "out.webp") {
		t.Errorf("args = %q", args)
	}
	if !strings.Contains(string(b), "-frames:v\n1") || !strings.Contains(string(b), "-map_metadata\n-1") {
		t.Errorf("args = %q", args)
	}
	if r.progress[0] != core.IndeterminateProgress {
		t.Errorf("progress = %v", r.progress)
	}
	if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "pic.webp" {
		t.Errorf("outputs = %v", r.outputs)
	}
}

func TestRunUnknownDuration(t *testing.T) {
	setFake(t, `out_time_us=1000000\nspeed=1x\nprogress=continue\nprogress=end\n`, "", 0)
	t.Setenv("FAKE_FF_DURATION", "N/A")
	var r recorder
	job := r.job(t, touch(t, "a.wav"), DefaultOptions())
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	for _, p := range r.progress[:len(r.progress)-1] {
		if p == 1 {
			continue
		}
		if p != core.IndeterminateProgress {
			t.Errorf("progress = %v", r.progress)
		}
	}
}

func TestRunErrorMapping(t *testing.T) {
	tests := []struct {
		name, stderr, wantMsg, wantHint string
	}{
		{"error line", `ffmpeg version\nsomething\nInvalid data found when processing input\nConversion failed!`,
			"Invalid data found when processing input", ""},
		{"fallback last", `foo\nbar`, "bar", ""},
		{"x265 hint", `Unknown encoder 'libx265'`, "Unknown encoder 'libx265'",
			"Your ffmpeg build lacks this encoder; install a full build (brew install ffmpeg)"},
		{"vp9 hint", `Unknown encoder 'libvpx-vp9'`, "Unknown encoder 'libvpx-vp9'",
			"Your ffmpeg build lacks this encoder; install a full build (brew install ffmpeg)"},
		{"no such file", `x: No such file or directory`, "x: No such file or directory", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setFake(t, "", tt.stderr, 1)
			var r recorder
			job := r.job(t, touch(t, "a.mp4"), Options{Preset: "mp4-h264", MaxHeight: HeightKeep})
			err := (&Module{}).Run(context.Background(), job)
			ae := core.AsAppError(err)
			if ae == nil || ae.Code != core.CodeToolFailed {
				t.Fatalf("err = %v", err)
			}
			if ae.Message != tt.wantMsg || ae.Hint != tt.wantHint {
				t.Errorf("message=%q hint=%q", ae.Message, ae.Hint)
			}
			if len(r.outputs) != 0 {
				t.Error("output registered on failure")
			}
			if len(r.stderr) == 0 {
				t.Error("stderr not logged")
			}
		})
	}
}

func TestRunCancel(t *testing.T) {
	setFake(t, "", "", 0)
	t.Setenv("FAKE_FF_HANG", "1")
	var r recorder
	job := r.job(t, touch(t, "a.wav"), DefaultOptions())
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(500 * time.Millisecond); cancel() }()
	start := time.Now()
	err := (&Module{}).Run(ctx, job)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 20*time.Second {
		t.Error("cancel too slow")
	}
	if len(r.outputs) != 0 {
		t.Error("output registered after cancel")
	}
}

func TestRunMissingTool(t *testing.T) {
	setFake(t, "", "", 0)
	var r recorder
	job := r.job(t, touch(t, "a.wav"), DefaultOptions())
	job = core.NewJobContext(*job, core.JobHooks{Tool: func(id string) (string, error) {
		return "", core.ErrDependencyMissing(id, "")
	}})
	err := (&Module{}).Run(context.Background(), job)
	if !core.IsCode(err, core.CodeDependencyMissing) {
		t.Errorf("err = %v", err)
	}
}

func TestMoveFileCopyFallback(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "s")
	_ = os.WriteFile(src, []byte("abc"), 0o644)
	dst := filepath.Join(dir, "sub", "d")
	if err := moveFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "abc" {
		t.Error("content")
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Error("src remains")
	}
}
