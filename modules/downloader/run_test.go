package downloader

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

// TestMain turns the test binary into a fake yt-dlp when FAKE_YTDLP_FIXTURE
// is set (the re-exec pattern).
func TestMain(m *testing.M) {
	if fx := os.Getenv("FAKE_YTDLP_FIXTURE"); fx != "" {
		os.Exit(fakeYtDlp(fx))
	}
	os.Exit(m.Run())
}

func fakeYtDlp(fixture string) int {
	home := ""
	args := os.Args[1:]
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-P" {
			if h, ok := strings.CutPrefix(args[i+1], "home:"); ok {
				home = h
			}
		}
	}
	if p := os.Getenv("FAKE_YTDLP_ARGSFILE"); p != "" {
		_ = os.WriteFile(p, []byte(strings.Join(args, "\n")), 0o644)
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake yt-dlp:", err)
		return 99
	}
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		if line == "" {
			continue
		}
		line = strings.ReplaceAll(line, "{{HOME}}", home)
		w := os.Stdout
		if rest, ok := strings.CutPrefix(line, "stderr:"); ok {
			line, w = rest, os.Stderr
		}
		if p, ok := strings.CutPrefix(line, "[tbx:out] "); ok {
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte("fake"), 0o644)
		}
		fmt.Fprintln(w, line)
	}
	if os.Getenv("FAKE_YTDLP_HANG") == "1" {
		time.Sleep(60 * time.Second)
	}
	code, _ := strconv.Atoi(os.Getenv("FAKE_YTDLP_EXIT"))
	return code
}

type recorder struct {
	mu       sync.Mutex
	progress []float64
	msgs     []string
	logs     []string
	stderr   []string
	titles   []string
	outputs  []string
}

func (r *recorder) job(t *testing.T, opts Options) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(opts)
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Inputs: []string{"https://example.com/v"}, Options: raw,
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
			r.logs = append(r.logs, string(s)+":"+l)
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
			switch id {
			case "yt-dlp":
				return os.Args[0], nil
			case "ffmpeg":
				return filepath.Join(t.TempDir(), "ffmpeg"), nil
			case "ffprobe":
				return filepath.Join(t.TempDir(), "ffprobe"), nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
}

func (r *recorder) hasLog(sub string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, l := range r.logs {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func setFake(t *testing.T, fixture string, exit int) {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_YTDLP_FIXTURE", abs)
	t.Setenv("FAKE_YTDLP_EXIT", strconv.Itoa(exit))
	t.Setenv("FAKE_YTDLP_HANG", "")
}

func TestRunSuccess(t *testing.T) {
	tests := []struct {
		fixture string
		outputs int
		title   string
	}{
		{"audio_mp3.txt", 1, "Me at the zoo"},
		{"video_merge_2streams.txt", 1, "Me at the zoo"},
		{"trim_section.txt", 1, "Me at the zoo"},
		{"unknown_total.txt", 1, "Live stream | part 1"},
		{"playlist_3.txt", 3, "First clip (+2 more)"},
	}
	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			setFake(t, tc.fixture, 0)
			var r recorder
			m := &Module{cacheDir: t.TempDir()}
			if err := m.Run(context.Background(), r.job(t, DefaultOptions())); err != nil {
				t.Fatalf("Run: %v", err)
			}
			if len(r.outputs) != tc.outputs {
				t.Errorf("outputs = %v", r.outputs)
			}
			if len(r.titles) != 1 || r.titles[0] != tc.title {
				t.Errorf("titles = %q, want %q", r.titles, tc.title)
			}
			if len(r.progress) == 0 || r.progress[len(r.progress)-1] != 1.0 {
				t.Errorf("progress = %v", r.progress)
			}
			if len(r.stderr) == 0 && tc.fixture == "audio_mp3.txt" {
				t.Error("stderr WARNING should be logged")
			}
			for _, l := range r.stderr {
				if strings.Contains(l, "[tbx:") {
					t.Errorf("tbx line logged as stderr: %q", l)
				}
			}
			for _, l := range r.logs {
				if strings.Contains(l, "[tbx:") {
					t.Errorf("tbx line logged: %q", l)
				}
			}
			if !r.hasLog("Starting \""+strings.SplitN(tc.title, " (+", 2)[0]+"\"") || !r.hasLog("Saved ") {
				t.Errorf("missing start/saved logs: %q", r.logs)
			}
			if !r.hasLog("No JavaScript runtime found") {
				t.Error("missing JS runtime warning")
			}
		})
	}
}

func TestRunPassesArgsAndWAVLog(t *testing.T) {
	setFake(t, "audio_mp3.txt", 0)
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("FAKE_YTDLP_ARGSFILE", argsFile)
	var r recorder
	opts := DefaultOptions()
	opts.AudioFormat = FormatWAV
	m := &Module{cacheDir: "/the/cache"}
	if err := m.Run(context.Background(), r.job(t, opts)); err != nil {
		t.Fatalf("Run: %v", err)
	}
	b, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Split(string(b), "\n")
	if !contains(args, "--cache-dir", "/the/cache") || !contains(args, "--audio-format", "wav") {
		t.Errorf("args: %q", args)
	}
	if args[len(args)-1] != "https://example.com/v" || args[len(args)-2] != "--" {
		t.Errorf("args tail: %q", args[len(args)-2:])
	}
	if !r.hasLog("Thumbnail embedding isn't supported for WAV, skipped") {
		t.Error("missing wav log line")
	}
}

func TestRunErrors(t *testing.T) {
	t.Run("unavailable", func(t *testing.T) {
		setFake(t, "error_unavailable.txt", 1)
		var r recorder
		err := (&Module{}).Run(context.Background(), r.job(t, DefaultOptions()))
		ae := core.AsAppError(err)
		if ae.Code != core.CodeToolFailed {
			t.Fatalf("err = %v", err)
		}
		if ae.Message != "[youtube] deadbeef000: Video unavailable. This video is private" {
			t.Errorf("message = %q", ae.Message)
		}
		if ae.Hint != "The video is private or unavailable" {
			t.Errorf("hint = %q", ae.Hint)
		}
	})
	t.Run("exit 0 without output", func(t *testing.T) {
		setFake(t, "error_unavailable.txt", 0)
		var r recorder
		err := (&Module{}).Run(context.Background(), r.job(t, DefaultOptions()))
		ae := core.AsAppError(err)
		if ae.Code != core.CodeToolFailed || ae.Message != "yt-dlp finished without producing a file" {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("exit code fallback", func(t *testing.T) {
		setFake(t, "unknown_total.txt", 7)
		var r recorder
		err := (&Module{}).Run(context.Background(), r.job(t, DefaultOptions()))
		ae := core.AsAppError(err)
		if ae.Code != core.CodeToolFailed || ae.Message != "yt-dlp exited with code 7" {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("missing tool", func(t *testing.T) {
		job := core.NewJobContext(core.JobContext{Inputs: []string{"https://x.com/a"}}, core.JobHooks{})
		err := (&Module{}).Run(context.Background(), job)
		if !core.IsCode(err, core.CodeDependencyMissing) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("bad options", func(t *testing.T) {
		job := core.NewJobContext(core.JobContext{Inputs: []string{"https://x.com/a"}, Options: json.RawMessage(`{"nope":1}`)}, core.JobHooks{})
		if err := (&Module{}).Run(context.Background(), job); !core.IsCode(err, core.CodeValidation) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestHintFor(t *testing.T) {
	tests := []struct {
		msg  string
		noJS bool
		want string
	}{
		{"ERROR: Unsupported URL: https://x", false, "This site isn't supported by yt-dlp"},
		{"Requested format is not available. Use --list-formats", false, "Try a lower max resolution or Best"},
		{"Sign in to confirm you're not a bot", false, "This video needs a signed-in session, which Toolbox doesn't support yet"},
		{"Use --cookies-from-browser", false, "This video needs a signed-in session, which Toolbox doesn't support yet"},
		{"unable to download: HTTP Error 403: Forbidden", false, "Update yt-dlp in Settings → Dependencies"},
		{"nsig extraction failed", true, "Update yt-dlp in Settings → Dependencies. Installing Deno may also help: " + denoInstallHint()},
		{"ffprobe and ffmpeg not found", false, ffmpegInstallHint()},
		{"Private video. Sign in", false, "The video is private or unavailable"},
		{"something else", false, ""},
	}
	for _, tc := range tests {
		if got := hintFor(tc.msg, tc.noJS); got != tc.want {
			t.Errorf("hintFor(%q) = %q, want %q", tc.msg, got, tc.want)
		}
	}
}

func TestRunCancel(t *testing.T) {
	setFake(t, "video_merge_2streams.txt", 0)
	t.Setenv("FAKE_YTDLP_HANG", "1")
	var r recorder
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			r.mu.Lock()
			n := len(r.progress)
			r.mu.Unlock()
			if n > 3 {
				cancel()
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		cancel()
	}()
	start := time.Now()
	err := (&Module{}).Run(ctx, r.job(t, DefaultOptions()))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if d := time.Since(start); d > 15*time.Second {
		t.Fatalf("cancel took %v; fake was not killed", d)
	}
}

func TestCleanErrorMessageAndNotFoundHint(t *testing.T) {
	msg := cleanErrorMessage("[generic] x: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)")
	if msg != "[generic] x: Unable to download webpage: HTTP Error 404: Not Found" {
		t.Fatalf("clean = %q", msg)
	}
	if h := hintFor(msg, false); h != "Check that the link is correct and the page still exists" {
		t.Fatalf("hint = %q", h)
	}
}
