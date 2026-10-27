package deps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

func TestAssetName(t *testing.T) {
	tests := []struct{ goos, arch, want string }{
		{"darwin", "arm64", "yt-dlp_macos"},
		{"darwin", "amd64", "yt-dlp_macos"},
		{"windows", "amd64", "yt-dlp.exe"},
		{"windows", "arm64", "yt-dlp_arm64.exe"},
		{"windows", "386", ""},
		{"linux", "amd64", "yt-dlp_linux"},
		{"linux", "arm64", "yt-dlp_linux_aarch64"},
		{"linux", "riscv64", ""},
		{"freebsd", "amd64", ""},
	}
	for _, tc := range tests {
		if got := assetName(tc.goos, tc.arch); got != tc.want {
			t.Errorf("%s/%s: got %q want %q", tc.goos, tc.arch, got, tc.want)
		}
	}
}

func TestUpdaterDescriptorAndValidate(t *testing.T) {
	reg := core.NewRegistry()
	s := newSvc(t, t.TempDir(), reg)
	if err := RegisterUpdater(reg, s); err != nil {
		t.Fatal(err)
	}
	m, ok := reg.Get(UpdateModuleID)
	if !ok {
		t.Fatal("not registered")
	}
	d := m.Descriptor()
	if !d.Hidden || d.MaxConcurrent != 1 || d.OutputSubdir != "" || d.Icon != "refresh-cw" || d.Category != core.CategoryUtility {
		t.Errorf("descriptor: %+v", d)
	}
	if err := m.Validate(nil, nil); err != nil {
		t.Error(err)
	}
	if err := m.Validate(nil, json.RawMessage(`{}`)); err != nil {
		t.Error(err)
	}
	if err := m.Validate([]string{"x"}, nil); err == nil {
		t.Error("inputs should be rejected")
	}
}

type gh struct {
	srv      *httptest.Server
	tag      string
	asset    []byte
	sums     string // "" = computed correctly
	hits     map[string]int
	mu       sync.Mutex
	uas      []string
	onAsset  func(w http.ResponseWriter, r *http.Request)
	assetLen int64 // overrides Content-Length when > 0
}

func newGH(t *testing.T, name string, asset []byte) *gh {
	g := &gh{tag: "2026.10.26", asset: asset, hits: map[string]int{}}
	mux := http.NewServeMux()
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	mux.HandleFunc("/repos/yt-dlp/yt-dlp/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		g.record(r)
		rel := map[string]any{"tag_name": g.tag, "assets": []map[string]string{
			{"name": name, "browser_download_url": g.srv.URL + "/dl/" + name},
			{"name": "SHA2-256SUMS", "browser_download_url": g.srv.URL + "/dl/SHA2-256SUMS"},
		}}
		json.NewEncoder(w).Encode(rel)
	})
	mux.HandleFunc("/dl/SHA2-256SUMS", func(w http.ResponseWriter, r *http.Request) {
		g.record(r)
		sum := g.sums
		if sum == "" {
			h := sha256.Sum256(g.asset)
			sum = hex.EncodeToString(h[:])
		}
		fmt.Fprintf(w, "%s  other-file\n%s  %s\n", strings.Repeat("0", 64), sum, name)
	})
	mux.HandleFunc("/dl/"+name, func(w http.ResponseWriter, r *http.Request) {
		g.record(r)
		if g.onAsset != nil {
			g.onAsset(w, r)
			return
		}
		w.Write(g.asset)
	})
	return g
}

func (g *gh) record(r *http.Request) {
	g.mu.Lock()
	g.hits[r.URL.Path]++
	g.uas = append(g.uas, r.UserAgent())
	g.mu.Unlock()
}

type progressRec struct {
	mu   sync.Mutex
	pcts []float64
	msg  string
	logs []string
}

func (p *progressRec) job(t *testing.T) *core.JobContext {
	return core.NewJobContext(core.JobContext{ID: "j", ModuleID: UpdateModuleID, TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(pct float64, msg string) {
			p.mu.Lock()
			p.pcts = append(p.pcts, pct)
			p.msg = msg
			p.mu.Unlock()
		},
		Log: func(_ core.LogStream, l string) {
			p.mu.Lock()
			p.logs = append(p.logs, l)
			p.mu.Unlock()
		},
	})
}

func testUpdater(t *testing.T, g *gh, goos, arch string) (*updater, string) {
	bin := filepath.Join(t.TempDir(), "bin")
	s := newSvc(t, bin, nil)
	u := newUpdater(s, g.srv.URL)
	u.goos, u.goarch = goos, arch
	s.goos = goos
	u.version = func(ctx context.Context, path string) (string, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	return u, bin
}

func TestUpdaterFreshInstall(t *testing.T) {
	g := newGH(t, "yt-dlp_linux", []byte("2026.10.26"))
	u, bin := testUpdater(t, g, "linux", "amd64")
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(bin, "yt-dlp"))
	if err != nil || string(b) != "2026.10.26" {
		t.Fatalf("installed: %q %v", b, err)
	}
	if rec.msg != "Installed yt-dlp 2026.10.26" || rec.pcts[len(rec.pcts)-1] != 1 {
		t.Errorf("final: %q %v", rec.msg, rec.pcts)
	}
	for _, p := range rec.pcts {
		if p > 1 {
			t.Errorf("progress %v", p)
		}
	}
	for _, ua := range g.uas {
		if ua != "Toolbox/"+core.Version {
			t.Errorf("UA %q", ua)
		}
	}
	if len(rec.logs) == 0 {
		t.Error("no logs")
	}
}

func TestUpdaterUpToDate(t *testing.T) {
	g := newGH(t, "yt-dlp_linux", []byte("2026.10.26"))
	u, bin := testUpdater(t, g, "linux", "amd64")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "yt-dlp"), []byte("2026.10.26\n"), 0o755)
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	if rec.msg != "Already up to date (2026.10.26)" || rec.pcts[len(rec.pcts)-1] != 1 {
		t.Errorf("msg=%q", rec.msg)
	}
	if g.hits["/dl/yt-dlp_linux"] != 0 {
		t.Error("downloaded despite being current")
	}
}

func TestUpdaterUpgradeReplaces(t *testing.T) {
	g := newGH(t, "yt-dlp_linux", []byte("2026.10.26"))
	u, bin := testUpdater(t, g, "linux", "amd64")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "yt-dlp"), []byte("2025.01.01"), 0o755)
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(bin, "yt-dlp")); string(b) != "2026.10.26" {
		t.Errorf("not replaced: %q", b)
	}
}

func TestUpdaterChecksumMismatch(t *testing.T) {
	g := newGH(t, "yt-dlp_linux", []byte("2026.10.26"))
	g.sums = strings.Repeat("a", 64)
	u, bin := testUpdater(t, g, "linux", "amd64")
	var rec progressRec
	err := u.Run(context.Background(), rec.job(t))
	if !core.IsCode(err, core.CodeToolFailed) || core.AsAppError(err).Message != "Checksum mismatch" {
		t.Fatalf("err=%v", err)
	}
	if _, serr := os.Stat(filepath.Join(bin, "yt-dlp")); serr == nil {
		t.Error("installed despite mismatch")
	}
}

func TestUpdaterOversize(t *testing.T) {
	g := newGH(t, "yt-dlp_linux", []byte(strings.Repeat("x", 4096)))
	u, _ := testUpdater(t, g, "linux", "amd64")
	u.maxSize = 1024
	var rec progressRec
	err := u.Run(context.Background(), rec.job(t))
	if !core.IsCode(err, core.CodeToolFailed) || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("err=%v", err)
	}
	// Unknown length (chunked) is also capped while streaming.
	g.onAsset = func(w http.ResponseWriter, r *http.Request) {
		w.(http.Flusher).Flush()
		w.Write(g.asset)
	}
	err = u.Run(context.Background(), rec.job(t))
	if !core.IsCode(err, core.CodeToolFailed) || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("chunked err=%v", err)
	}
}

func TestUpdaterCancelMidDownload(t *testing.T) {
	g := newGH(t, "yt-dlp_linux", nil)
	started := make(chan struct{})
	g.onAsset = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000000")
		w.Write(make([]byte, 1000))
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}
	u, bin := testUpdater(t, g, "linux", "amd64")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	var rec progressRec
	go func() { done <- u.Run(ctx, rec.job(t)) }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !core.IsCode(err, core.CodeCancelled) {
			t.Fatalf("err=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if _, err := os.Stat(filepath.Join(bin, "yt-dlp")); err == nil {
		t.Error("installed after cancel")
	}
}

func TestUpdaterUnsupportedPlatform(t *testing.T) {
	g := newGH(t, "yt-dlp_linux", []byte("x"))
	u, _ := testUpdater(t, g, "plan9", "mips")
	var rec progressRec
	err := u.Run(context.Background(), rec.job(t))
	if !core.IsCode(err, core.CodeInternal) || core.AsAppError(err).Message != "Unsupported platform" {
		t.Fatalf("err=%v", err)
	}
}

func TestUpdaterHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	s := newSvc(t, t.TempDir(), nil)
	u := newUpdater(s, srv.URL)
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); !core.IsCode(err, core.CodeToolFailed) {
		t.Fatalf("err=%v", err)
	}
}
