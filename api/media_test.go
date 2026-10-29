package api

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/media"
)

// TestMain turns the test binary into a fake ffprobe/ffmpeg when
// FAKE_MEDIA_TOOL is set (the re-exec pattern).
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_MEDIA_TOOL") == "1" {
		fakeTool()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeTool() {
	args := os.Args[1:]
	if slices.Contains(args, "-show_format") || slices.Contains(args, "-show_entries") {
		fmt.Print(os.Getenv("FAKE_PROBE_STDOUT"))
		return
	}
	if f := os.Getenv("FAKE_ARGS_FILE"); f != "" {
		_ = os.WriteFile(f, []byte(strings.Join(args, "\n")), 0o644)
	}
	out := args[len(args)-1]
	var data []byte
	if slices.Contains(args, "s16le") {
		data = make([]byte, 2000)
		for i := 0; i < 1000; i++ {
			binary.LittleEndian.PutUint16(data[i*2:], uint16(int16(-i*32))) // negative: |s| must be used
		}
	} else {
		data = []byte("fake-output")
	}
	if err := os.WriteFile(out, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("progress=end")
}

func probeFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "core", "media", "testdata", "probe", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func fakeService(t *testing.T) *MediaService {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_MEDIA_TOOL", "1")
	t.Setenv("FAKE_PROBE_STDOUT", probeFixture(t, "plain"))
	return &MediaService{
		Paths:   core.Paths{CacheDir: t.TempDir()},
		Resolve: func(string) (string, error) { return exe, nil },
		GOOS:    "windows",
	}
}

func writeFile(t *testing.T, name string, size int) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	b := make([]byte, size)
	for i := range b {
		b[i] = byte(i % 251)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func get(t *testing.T, h http.Handler, method, url, rng string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, url, nil)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func routeHandler(s *MediaService) (http.Handler, *bool) {
	passed := new(bool)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { *passed = true; w.WriteHeader(204) })
	return MediaMiddleware(s)(next), passed
}

func TestMediaRoute(t *testing.T) {
	s := &MediaService{}
	h, passed := routeHandler(s)
	big := writeFile(t, "big.mp4", 10<<20)
	small := writeFile(t, "small.MP3", 1000)
	bigURL, _ := s.URLFor(big)
	smallURL, _ := s.URLFor(small)
	if again, _ := s.URLFor(big); again != bigURL {
		t.Error("token should be reused for the same path")
	}
	mib := int64(MaxMediaResponse)

	t.Run("unknown token", func(t *testing.T) {
		if r := get(t, h, "GET", "/media/deadbeef/x.mp4", ""); r.Code != 404 {
			t.Errorf("code %d", r.Code)
		}
	})
	t.Run("passthrough", func(t *testing.T) {
		*passed = false
		get(t, h, "GET", "/index.html", "")
		if !*passed {
			t.Error("not passed")
		}
	})
	t.Run("methods", func(t *testing.T) {
		if r := get(t, h, "POST", bigURL, ""); r.Code != 405 {
			t.Errorf("code %d", r.Code)
		}
		r := get(t, h, "HEAD", smallURL, "")
		if r.Code != 200 || r.Body.Len() != 0 || r.Header().Get("Content-Length") != "1000" {
			t.Errorf("head: %d %d %v", r.Code, r.Body.Len(), r.Header())
		}
	})
	t.Run("open range capped", func(t *testing.T) {
		r := get(t, h, "GET", bigURL, "bytes=0-")
		want := fmt.Sprintf("bytes 0-%d/%d", mib-1, 10<<20)
		if r.Code != 206 || r.Header().Get("Content-Range") != want || int64(r.Body.Len()) != mib {
			t.Errorf("%d %q %d", r.Code, r.Header().Get("Content-Range"), r.Body.Len())
		}
		if r.Header().Get("Accept-Ranges") != "bytes" || r.Header().Get("Cache-Control") != "no-store" ||
			r.Header().Get("Content-Type") != "video/mp4" {
			t.Errorf("headers %v", r.Header())
		}
	})
	t.Run("exact and suffix", func(t *testing.T) {
		r := get(t, h, "GET", bigURL, "bytes=10-19")
		b, _ := io.ReadAll(r.Body)
		if r.Code != 206 || len(b) != 10 || b[0] != byte(10%251) || r.Header().Get("Content-Range") != "bytes 10-19/10485760" {
			t.Errorf("%d %d %q", r.Code, len(b), r.Header().Get("Content-Range"))
		}
		r = get(t, h, "GET", smallURL, "bytes=-100")
		if r.Code != 206 || r.Body.Len() != 100 || r.Header().Get("Content-Range") != "bytes 900-999/1000" {
			t.Errorf("suffix %d %d %q", r.Code, r.Body.Len(), r.Header().Get("Content-Range"))
		}
		if r.Header().Get("Content-Type") != "audio/mpeg" {
			t.Errorf("type %q", r.Header().Get("Content-Type"))
		}
	})
	t.Run("416", func(t *testing.T) {
		for _, rng := range []string{"bytes=2000-", "bytes=5-2", "bytes=abc", "bytes=0-1,5-6", "items=0-1", "bytes=-0"} {
			r := get(t, h, "GET", smallURL, rng)
			if r.Code != 416 || r.Header().Get("Content-Range") != "bytes */1000" {
				t.Errorf("%s: %d %q", rng, r.Code, r.Header().Get("Content-Range"))
			}
		}
	})
	t.Run("no range", func(t *testing.T) {
		r := get(t, h, "GET", smallURL, "")
		if r.Code != 200 || r.Body.Len() != 1000 {
			t.Errorf("small %d %d", r.Code, r.Body.Len())
		}
		r = get(t, h, "GET", bigURL, "")
		if r.Code != 206 || int64(r.Body.Len()) != mib || !strings.HasPrefix(r.Header().Get("Content-Range"), "bytes 0-4194303/") {
			t.Errorf("big %d %d %q", r.Code, r.Body.Len(), r.Header().Get("Content-Range"))
		}
	})
	t.Run("content types", func(t *testing.T) {
		for ext, want := range map[string]string{".mkv": "video/x-matroska", ".webm": "video/webm", ".png": "image/png",
			".opus": "audio/ogg", ".xyz": "application/octet-stream"} {
			p := writeFile(t, "f"+ext, 10)
			u, _ := s.URLFor(p)
			if got := get(t, h, "GET", u, "").Header().Get("Content-Type"); got != want {
				t.Errorf("%s: %q", ext, got)
			}
		}
	})
	t.Run("concurrent", func(t *testing.T) {
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if r := get(t, h, "GET", bigURL, "bytes=100-199"); r.Body.Len() != 100 {
					t.Errorf("len %d", r.Body.Len())
				}
			}()
		}
		wg.Wait()
	})
	t.Run("deleted file", func(t *testing.T) {
		_ = os.Remove(small)
		if r := get(t, h, "GET", smallURL, ""); r.Code != 404 {
			t.Errorf("code %d", r.Code)
		}
		_, err := s.URLFor(small)
		if ae, ok := err.(*core.AppError); !ok || ae.Code != core.CodeNotFound {
			t.Errorf("err %v", err)
		}
	})
}

func TestTokenLRU(t *testing.T) {
	var tt tokenTable
	first := tt.tokenFor("/a")
	for i := 0; i < tokenLRUSize; i++ {
		tt.tokenFor(fmt.Sprintf("/p%d", i))
	}
	if _, ok := tt.lookup(first); ok {
		t.Error("oldest token should be evicted")
	}
	if tt.order.Len() != tokenLRUSize {
		t.Errorf("len %d", tt.order.Len())
	}
}

func TestOpenDecisionTable(t *testing.T) {
	s := fakeService(t)
	var submitted [][]string
	var running []core.Job
	s.submit = func(_ context.Context, mod string, in []string, opts string) ([]core.Job, error) {
		if mod != media.ProxyModuleID || opts != "{}" {
			t.Errorf("submit %s %s", mod, opts)
		}
		submitted = append(submitted, in)
		return []core.Job{{ID: "new-job"}}, nil
	}
	s.list = func(_ context.Context, f core.JobFilter) ([]core.Job, error) {
		if f.ModuleID != media.ProxyModuleID {
			t.Errorf("filter %+v", f)
		}
		return running, nil
	}

	dir := t.TempDir()
	mp4 := filepath.Join(dir, "a.mp4")
	mkv := filepath.Join(dir, "b.mkv")
	_ = os.WriteFile(mp4, []byte("x"), 0o644)
	_ = os.WriteFile(mkv, []byte("yy"), 0o644)

	src, err := s.Open(mp4)
	if err != nil || src.Proxy || src.ProxyJobID != "" || !strings.HasPrefix(src.URL, MediaPrefix) || src.Info.Video == nil {
		t.Fatalf("playable: %v %+v", err, src)
	}
	src, err = s.Open(mkv)
	if err != nil || src.URL != "" || src.ProxyJobID != "new-job" || len(submitted) != 1 || submitted[0][0] != mkv {
		t.Fatalf("new: %v %+v %v", err, src, submitted)
	}
	running = []core.Job{{ID: "other", Inputs: []string{"zzz"}}, {ID: "run-1", Inputs: []string{mkv}}}
	src, _ = s.Open(mkv)
	if src.ProxyJobID != "run-1" || len(submitted) != 1 {
		t.Fatalf("running: %+v", src)
	}
	fi, _ := os.Stat(mkv)
	pp := media.ProxyPath(media.CacheDir(s.Paths), mkv, fi.Size(), fi.ModTime().UnixNano(), false)
	_ = os.MkdirAll(filepath.Dir(pp), 0o755)
	_ = os.WriteFile(pp, []byte("proxy"), 0o644)
	src, _ = s.Open(mkv)
	if !src.Proxy || src.URL == "" || src.ProxyJobID != "" {
		t.Fatalf("cached: %+v", src)
	}
	later := fi.ModTime().Add(time.Hour)
	_ = os.Chtimes(mkv, later, later)
	running = nil
	src, _ = s.Open(mkv)
	if src.Proxy || src.ProxyJobID != "new-job" {
		t.Fatalf("mtime: %+v", src)
	}
	if _, err := s.Open(filepath.Join(dir, "nope.mkv")); err == nil {
		t.Error("missing file should error")
	}
}

func TestWaveformPeaks(t *testing.T) {
	s := fakeService(t)
	f := writeFile(t, "a.mp3", 100)
	if _, err := s.Waveform(f, 99); err == nil {
		t.Error("expected validation error")
	}
	peaks, err := s.Waveform(f, 100)
	if err != nil || len(peaks) != 100 {
		t.Fatalf("%v %d", err, len(peaks))
	}
	for b, p := range peaks {
		want := float32((b*10+9)*32) / 32768
		if p != want {
			t.Fatalf("bucket %d = %v want %v", b, p, want)
		}
	}
	exe, _ := os.Executable()
	s.Resolve = func(id string) (string, error) {
		if id == "ffprobe" {
			return exe, nil
		}
		return "", fmt.Errorf("ffmpeg must not run")
	}
	again, err := s.Waveform(f, 100)
	if err != nil || again[50] != peaks[50] {
		t.Errorf("cache: %v", err)
	}
}

func TestFilmstripAndFrame(t *testing.T) {
	s := fakeService(t)
	argsFile := filepath.Join(t.TempDir(), "args")
	t.Setenv("FAKE_ARGS_FILE", argsFile)
	f := writeFile(t, "a.mp4", 100)
	for _, c := range [][2]int{{3, 80}, {61, 80}, {10, 39}, {10, 161}} {
		if _, err := s.Filmstrip(f, c[0], c[1]); err == nil {
			t.Errorf("filmstrip %v should fail", c)
		}
	}
	u, err := s.Filmstrip(f, 10, 80)
	if err != nil || !strings.HasPrefix(u, MediaPrefix) {
		t.Fatalf("%v %q", err, u)
	}
	args, _ := os.ReadFile(argsFile)
	if !strings.Contains(string(args), "tile=10x1") || !strings.Contains(string(args), "scale=-2:80") {
		t.Errorf("args %s", args)
	}
	h, _ := routeHandler(s)
	if r := get(t, h, "GET", u, ""); r.Code != 200 || r.Body.String() != "fake-output" {
		t.Errorf("serve %d", r.Code)
	}
	if _, err := s.Frame(f, 1000, 63); err == nil {
		t.Error("frame range")
	}
	if _, err := s.Frame(f, -1, 640); err == nil {
		t.Error("frame ms")
	}
	if u, err := s.Frame(f, 1000, 640); err != nil || u == "" {
		t.Errorf("frame %v", err)
	}
}

func TestKeyframesSubtractStart(t *testing.T) {
	s := fakeService(t)
	f := writeFile(t, "a.mp4", 10)
	t.Setenv("FAKE_PROBE_STDOUT", probeFixture(t, "subs")) // startMs 1500
	if _, err := s.Open(f); err != nil {                   // primes the probe cache
		t.Fatal(err)
	}
	t.Setenv("FAKE_PROBE_STDOUT", "0.000000,\n1.500000,\n3.000000\n")
	got, err := s.Keyframes(f)
	if err != nil || len(got) != 3 || got[0] != 0 || got[1] != 0 || got[2] != 1500 {
		t.Errorf("%v %v", got, err)
	}
}
