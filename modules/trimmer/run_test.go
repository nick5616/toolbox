package trimmer

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

func hasArg(args []string, a string) bool {
	for _, x := range args {
		if x == a {
			return true
		}
	}
	return false
}

func fakeFF() int {
	args := os.Args[1:]
	switch {
	case hasArg(args, "-print_format"):
		fmt.Println(os.Getenv("FAKE_FF_PROBE_JSON"))
		return 0
	case hasArg(args, "-skip_frame"):
		fmt.Print(strings.ReplaceAll(os.Getenv("FAKE_FF_KEYFRAMES"), ",", "\n"))
		return 0
	}
	if p := os.Getenv("FAKE_FF_ARGSFILE"); p != "" {
		f, _ := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		fmt.Fprintln(f, strings.Join(args, " "))
		f.Close()
	}
	code := 0
	if os.Getenv("FAKE_FF_FAIL") == "1" {
		fmt.Fprintln(os.Stderr, "Invalid data found")
		code = 1
	}
	fmt.Print("out_time_us=1000000\nspeed=2.0x\nprogress=continue\nprogress=end\n")
	if os.Getenv("FAKE_FF_HANG") == "1" {
		time.Sleep(60 * time.Second)
	}
	if last := args[len(args)-1]; code == 0 && last != "-" {
		_ = os.WriteFile(last, []byte("trimmed"), 0o644)
	}
	return code
}

const probeVideo = `{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30/1","pix_fmt":"yuv420p"},{"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"48000"}],"format":{"format_name":"mov,mp4","start_time":"0.000000","duration":"100.000000","size":"1000"}}`
const probeAudio = `{"streams":[{"index":0,"codec_type":"audio","codec_name":"mp3","channels":2,"sample_rate":"44100"}],"format":{"format_name":"mp3","start_time":"0.000000","duration":"100.000000","size":"1000"}}`

type rec struct {
	mu       sync.Mutex
	progress []string
	outputs  []string
	results  []json.RawMessage
}

func (r *rec) job(t *testing.T, input string, opts Options) (*core.JobContext, string) {
	t.Helper()
	raw, _ := json.Marshal(opts)
	outDir := filepath.Join(t.TempDir(), "out")
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: outDir, TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(p float64, m string) { r.mu.Lock(); r.progress = append(r.progress, m); r.mu.Unlock() },
		Output: func(p string) (core.Output, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if _, err := os.Stat(p); err != nil {
				return core.Output{}, err
			}
			r.outputs = append(r.outputs, p)
			return core.Output{Path: p}, nil
		},
		Result: func(b json.RawMessage) { r.mu.Lock(); r.results = append(r.results, b); r.mu.Unlock() },
		Tool: func(id string) (string, error) {
			if id == "ffmpeg" || id == "ffprobe" {
				return os.Args[0], nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	}), outDir
}

func setup(t *testing.T, name, probe string) (input, argsFile string) {
	t.Helper()
	dir := t.TempDir()
	input = filepath.Join(dir, name)
	if err := os.WriteFile(input, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	argsFile = filepath.Join(dir, "args.txt")
	t.Setenv("FAKE_FF_MODE", "1")
	t.Setenv("FAKE_FF_PROBE_JSON", probe)
	t.Setenv("FAKE_FF_ARGSFILE", argsFile)
	t.Setenv("FAKE_FF_KEYFRAMES", "0.000,10.000,20.000")
	return input, argsFile
}

func calls(t *testing.T, argsFile string) []string {
	t.Helper()
	b, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	ents, _ := os.ReadDir(dir)
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func TestRunFastMerge(t *testing.T) {
	input, argsFile := setup(t, "clip.mts", probeVideo)
	o := opt(func(o *Options) {
		o.Segments = []Segment{{5000, 8000}, {15000, 18000}}
		o.RemoveAudio = true
	})
	var r rec
	job, outDir := r.job(t, input, o)
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if got := names(t, outDir); len(got) != 1 || got[0] != "clip (trim).ts" {
		t.Fatalf("outputs %v", got)
	}
	c := calls(t, argsFile)
	if len(c) != 3 || !strings.Contains(c[0], "-ss 5.000 -to 8.000") || !strings.Contains(c[0], "-an") ||
		!strings.Contains(c[2], "-f concat") {
		t.Fatalf("calls %v", c)
	}
	var res Result
	if err := json.Unmarshal(r.results[0], &res); err != nil || res.MaxShiftMs != 5000 || len(res.Outputs) != 1 {
		t.Fatalf("result %s %v", r.results[0], err)
	}
	if last := r.progress[len(r.progress)-1]; !strings.Contains(last, "early") {
		t.Fatalf("final message %q", last)
	}
	// unique name on a second run
	job2, _ := r.job(t, input, o)
	job2.OutputDir = outDir
	if err := (&Module{}).Run(context.Background(), job2); err != nil {
		t.Fatal(err)
	}
	if got := names(t, outDir); len(got) != 2 || got[0] != "clip (trim) (1).ts" {
		t.Fatalf("outputs %v", got)
	}
}

func TestRunFastSeparate(t *testing.T) {
	input, argsFile := setup(t, "clip.mp4", probeVideo)
	o := opt(func(o *Options) { o.Segments = []Segment{{0, 3000}, {15000, 18000}}; o.Join = JoinSeparate })
	var r rec
	job, outDir := r.job(t, input, o)
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if got := names(t, outDir); len(got) != 2 || got[0] != "clip (part 1).mp4" || got[1] != "clip (part 2).mp4" {
		t.Fatalf("outputs %v", got)
	}
	if len(calls(t, argsFile)) != 2 || len(r.outputs) != 2 {
		t.Fatal("expected two ffmpeg runs and outputs")
	}
}

func TestRunPreciseTwoPass(t *testing.T) {
	input, argsFile := setup(t, "clip.mkv", probeVideo)
	o := opt(func(o *Options) {
		o.Mode, o.Aspect, o.MaxSizeMB, o.MaxHeight = ModePrecise, AspectPortrait, 50, 720
		o.Segments = []Segment{{0, 10000}}
	})
	var r rec
	job, outDir := r.job(t, input, o)
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if got := names(t, outDir); len(got) != 1 || got[0] != "clip (trim).mp4" {
		t.Fatalf("outputs %v", got)
	}
	c := calls(t, argsFile)
	if len(c) != 2 || !strings.Contains(c[0], "-pass 1") || !strings.Contains(c[1], "-pass 2") ||
		!strings.Contains(c[1], "crop=608:1080:656:0,scale=-2:720") {
		t.Fatalf("calls %v", c)
	}
}

func TestRunPreciseAudioOnly(t *testing.T) {
	input, argsFile := setup(t, "song.mp3", probeAudio)
	o := opt(func(o *Options) { o.Mode = ModePrecise })
	var r rec
	job, outDir := r.job(t, input, o)
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if got := names(t, outDir); len(got) != 1 || got[0] != "song (trim).mp3" {
		t.Fatalf("outputs %v", got)
	}
	if c := calls(t, argsFile); !strings.Contains(c[0], "libmp3lame") {
		t.Fatalf("calls %v", c)
	}
}

func TestRunFailureAndCancel(t *testing.T) {
	input, _ := setup(t, "clip.mp4", probeVideo)
	t.Setenv("FAKE_FF_FAIL", "1")
	var r rec
	job, outDir := r.job(t, input, opt(nil))
	err := (&Module{}).Run(context.Background(), job)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeToolFailed || !strings.Contains(ae.Message, "Invalid data") {
		t.Fatalf("err = %v", err)
	}
	if _, serr := os.Stat(outDir); serr == nil {
		t.Fatalf("output dir has %v", names(t, outDir))
	}

	t.Setenv("FAKE_FF_FAIL", "")
	t.Setenv("FAKE_FF_HANG", "1")
	job, outDir = r.job(t, input, opt(nil))
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(500 * time.Millisecond); cancel() }()
	start := time.Now()
	err = (&Module{}).Run(ctx, job)
	if !errors.Is(err, context.Canceled) || time.Since(start) > 20*time.Second {
		t.Fatalf("err = %v after %v", err, time.Since(start))
	}
	if _, serr := os.Stat(outDir); serr == nil {
		t.Fatalf("cancel left %v", names(t, outDir))
	}
	if len(r.outputs) != 0 {
		t.Fatal("outputs registered")
	}
}

func TestValidateViaProbe(t *testing.T) {
	input, _ := setup(t, "clip.mp4", probeVideo)
	m := &Module{resolve: func(string) (string, error) { return os.Args[0], nil }}
	good, _ := json.Marshal(opt(nil))
	if err := m.Validate([]string{input}, good); err != nil {
		t.Fatal(err)
	}
	past, _ := json.Marshal(opt(func(o *Options) { o.Segments = []Segment{{0, 200000}} }))
	if err := m.Validate([]string{input}, past); err == nil {
		t.Fatal("expected past-end error")
	}
	if err := m.Validate([]string{input}, json.RawMessage(`{"bogus":1}`)); err == nil {
		t.Fatal("expected strict decode error")
	}
	miss := &Module{resolve: func(id string) (string, error) { return "", core.ErrDependencyMissing(id, "") }}
	var ae *core.AppError
	if err := miss.Validate([]string{input}, good); !errors.As(err, &ae) || ae.Code != core.CodeDependencyMissing {
		t.Fatalf("err = %v", err)
	}
	if err := m.Validate([]string{input, input}, good); err == nil {
		t.Fatal("two inputs")
	}
}
