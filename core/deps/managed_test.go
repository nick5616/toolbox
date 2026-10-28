package deps

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
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
	"testing"

	"toolbox/core"
)

func TestUVAssets(t *testing.T) {
	tests := []struct{ goos, arch, want string }{
		{"darwin", "arm64", "uv-aarch64-apple-darwin.tar.gz"},
		{"darwin", "amd64", "uv-x86_64-apple-darwin.tar.gz"},
		{"windows", "amd64", "uv-x86_64-pc-windows-msvc.zip"},
		{"windows", "arm64", "uv-aarch64-pc-windows-msvc.zip"},
		{"linux", "amd64", "uv-x86_64-unknown-linux-gnu.tar.gz"},
		{"linux", "arm64", "uv-aarch64-unknown-linux-gnu.tar.gz"},
		{"linux", "386", ""},
		{"plan9", "amd64", ""},
	}
	for _, tc := range tests {
		got, err := UVBinary().Asset(tc.goos, tc.arch)
		if (tc.want == "") != (err != nil) || got != tc.want {
			t.Errorf("%s/%s: %q %v", tc.goos, tc.arch, got, err)
		}
	}
	b := YtDlpBinary()
	if n, err := b.Asset("linux", "amd64"); err != nil || n != "yt-dlp_linux" || b.Checksum != ChecksumSumsFile || b.SumsFile != "SHA2-256SUMS" {
		t.Errorf("yt-dlp spec: %q %v", n, err)
	}
	if _, err := b.Asset("plan9", "mips"); err == nil {
		t.Error("expected unsupported platform")
	}
}

func zipWith(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func tgzWith(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

type uvRelease struct {
	srv   *httptest.Server
	tag   string
	name  string
	asset []byte
	sum   string // "" = correct; "format" uses "<hex>  <name>"
	plain bool   // .sha256 file holds just the hex
	hits  map[string]int
}

func newUVRelease(t *testing.T, name string, asset []byte) *uvRelease {
	r := &uvRelease{tag: "0.13.6", name: name, asset: asset, hits: map[string]int{}}
	mux := http.NewServeMux()
	r.srv = httptest.NewServer(mux)
	t.Cleanup(r.srv.Close)
	mux.HandleFunc("/repos/astral-sh/uv/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"tag_name": r.tag, "assets": []map[string]string{
			{"name": name, "browser_download_url": r.srv.URL + "/dl/" + name},
			{"name": name + ".sha256", "browser_download_url": r.srv.URL + "/dl/" + name + ".sha256"},
		}})
	})
	mux.HandleFunc("/dl/"+name+".sha256", func(w http.ResponseWriter, _ *http.Request) {
		sum := r.sum
		if sum == "" {
			h := sha256.Sum256(r.asset)
			sum = hex.EncodeToString(h[:])
		}
		if r.plain {
			fmt.Fprintf(w, "%s\n", sum)
		} else {
			fmt.Fprintf(w, "%s *%s\n", sum, name)
		}
	})
	mux.HandleFunc("/dl/"+name, func(w http.ResponseWriter, _ *http.Request) {
		r.hits[name]++
		w.Write(r.asset)
	})
	return r
}

func uvUpdater(t *testing.T, r *uvRelease, goos, arch string) (*updater, string) {
	bin := filepath.Join(t.TempDir(), "bin")
	s := newSvc(t, bin, nil)
	u := newUpdater(s, r.srv.URL)
	u.spec = UVBinary()
	u.goos, u.goarch = goos, arch
	s.goos = goos
	u.version = func(ctx context.Context, path string) (string, error) {
		b, err := os.ReadFile(path)
		return strings.TrimSpace(string(b)), err
	}
	return u, bin
}

func TestManagedZipNestedMember(t *testing.T) {
	asset := zipWith(t, map[string]string{
		"uv-x86_64-pc-windows-msvc/README.md": "readme",
		"uv-x86_64-pc-windows-msvc/uvx.exe":   "uv 0.0.0 (wrong member)",
		"uv-x86_64-pc-windows-msvc/uv.exe":    "uv 0.13.6 (abc 2026-10-20)",
	})
	r := newUVRelease(t, "uv-x86_64-pc-windows-msvc.zip", asset)
	u, bin := uvUpdater(t, r, "windows", "amd64")
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(bin, "uv.exe"))
	if err != nil || string(b) != "uv 0.13.6 (abc 2026-10-20)" {
		t.Fatalf("installed %q %v", b, err)
	}
	if rec.msg != "Installed uv 0.13.6" || rec.pcts[len(rec.pcts)-1] != 1 {
		t.Errorf("final %q %v", rec.msg, rec.pcts)
	}
	for _, p := range rec.pcts {
		if p > 1 {
			t.Errorf("progress %v", p)
		}
	}
}

func TestManagedTarGzTopLevelMember(t *testing.T) {
	asset := tgzWith(t, map[string]string{"uv": "uv 0.13.6 (x)", "uvx": "other"})
	r := newUVRelease(t, "uv-x86_64-unknown-linux-gnu.tar.gz", asset)
	r.plain = true // bare-hex .sha256
	u, bin := uvUpdater(t, r, "linux", "amd64")
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(bin, "uv")); string(b) != "uv 0.13.6 (x)" {
		t.Errorf("installed %q", b)
	}
	if fi, err := os.Stat(filepath.Join(bin, "uv")); err != nil || fi.Mode().Perm()&0o100 == 0 && u.goos != "windows" && os.PathSeparator == '/' {
		t.Errorf("not executable: %v", err)
	}
}

func TestManagedTarGzNestedFolder(t *testing.T) {
	asset := tgzWith(t, map[string]string{"uv-aarch64-apple-darwin/uv": "uv 0.13.6 (x)", "uv-aarch64-apple-darwin/uvx": "o"})
	r := newUVRelease(t, "uv-aarch64-apple-darwin.tar.gz", asset)
	u, bin := uvUpdater(t, r, "darwin", "arm64")
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(bin, "uv")); string(b) != "uv 0.13.6 (x)" {
		t.Errorf("installed %q", b)
	}
}

func TestManagedMemberMissing(t *testing.T) {
	asset := tgzWith(t, map[string]string{"uvx": "o"})
	r := newUVRelease(t, "uv-x86_64-unknown-linux-gnu.tar.gz", asset)
	u, bin := uvUpdater(t, r, "linux", "amd64")
	var rec progressRec
	err := u.Run(context.Background(), rec.job(t))
	if !core.IsCode(err, core.CodeToolFailed) || !strings.Contains(err.Error(), "didn't contain uv") {
		t.Fatalf("err=%v", err)
	}
	if _, serr := os.Stat(filepath.Join(bin, "uv")); serr == nil {
		t.Error("installed")
	}
}

func TestManagedPerAssetChecksumMismatch(t *testing.T) {
	asset := tgzWith(t, map[string]string{"uv": "uv 0.13.6 (x)"})
	r := newUVRelease(t, "uv-x86_64-unknown-linux-gnu.tar.gz", asset)
	r.sum = strings.Repeat("b", 64)
	u, bin := uvUpdater(t, r, "linux", "amd64")
	var rec progressRec
	err := u.Run(context.Background(), rec.job(t))
	if !core.IsCode(err, core.CodeToolFailed) || core.AsAppError(err).Message != "Checksum mismatch" {
		t.Fatalf("err=%v", err)
	}
	if _, serr := os.Stat(filepath.Join(bin, "uv")); serr == nil {
		t.Error("installed despite mismatch")
	}
}

func TestManagedOversizeArchiveAndMember(t *testing.T) {
	asset := tgzWith(t, map[string]string{"uv": strings.Repeat("x", 100000)})
	r := newUVRelease(t, "uv-x86_64-unknown-linux-gnu.tar.gz", asset)
	u, _ := uvUpdater(t, r, "linux", "amd64")
	var rec progressRec

	u.maxSize = int64(len(asset)) - 1 // archive itself too large
	err := u.Run(context.Background(), rec.job(t))
	if !core.IsCode(err, core.CodeToolFailed) || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("archive: %v", err)
	}
	u.maxSize = 50000 // gzip shrinks the repeated bytes below the cap, the member does not
	if int64(len(asset)) < u.maxSize {
		err = u.Run(context.Background(), rec.job(t))
		if !core.IsCode(err, core.CodeToolFailed) || !strings.Contains(err.Error(), "too large") {
			t.Fatalf("member: %v", err)
		}
	}
}

func TestManagedAlreadyUpToDate(t *testing.T) {
	asset := tgzWith(t, map[string]string{"uv": "uv 0.13.6 (x)"})
	r := newUVRelease(t, "uv-x86_64-unknown-linux-gnu.tar.gz", asset)
	u, bin := uvUpdater(t, r, "linux", "amd64")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "uv"), []byte("uv 0.13.6 (abc 2026-10-20)\n"), 0o755)
	var rec progressRec
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	if rec.msg != "Already up to date (0.13.6)" || rec.pcts[len(rec.pcts)-1] != 1 {
		t.Errorf("msg=%q", rec.msg)
	}
	if r.hits["uv-x86_64-unknown-linux-gnu.tar.gz"] != 0 {
		t.Error("downloaded although current")
	}
	// An older install is replaced.
	os.WriteFile(filepath.Join(bin, "uv"), []byte("uv 0.12.0 (old)"), 0o755)
	if err := u.Run(context.Background(), rec.job(t)); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(bin, "uv")); string(b) != "uv 0.13.6 (x)" {
		t.Errorf("not upgraded: %q", b)
	}
}

func TestInstallManagedBinaryOnService(t *testing.T) {
	asset := tgzWith(t, map[string]string{"uv": "uv 0.13.6 (x)"})
	r := newUVRelease(t, "uv-x86_64-unknown-linux-gnu.tar.gz", asset)
	bin := filepath.Join(t.TempDir(), "bin")
	s := newSvc(t, bin, nil)
	s.githubBase = r.srv.URL
	// Real GOOS/GOARCH are used here, so only run where the fixture matches.
	if name, _ := UVBinary().Asset(s.goos, "amd64"); name != "uv-x86_64-unknown-linux-gnu.tar.gz" || s.goos != "linux" {
		t.Skip("fixture is linux/amd64 only; covered via updater tests")
	}
	var rec progressRec
	if err := s.InstallManagedBinary(context.Background(), rec.job(t), UVBinary()); err != nil {
		t.Fatal(err)
	}
}

func TestUVUpdaterModule(t *testing.T) {
	reg := core.NewRegistry()
	s := newSvc(t, t.TempDir(), reg)
	if err := RegisterUVUpdater(reg, s); err != nil {
		t.Fatal(err)
	}
	m, ok := reg.Get(UVUpdateModuleID)
	if !ok {
		t.Fatal("not registered")
	}
	d := m.Descriptor()
	if !d.Hidden || d.MaxConcurrent != 1 || d.ID != UVUpdateModuleID {
		t.Errorf("%+v", d)
	}
	if err := m.Validate([]string{"x"}, nil); err == nil {
		t.Error("inputs should be rejected")
	}
	// Not counted as a requirer of anything, and uv itself has no RequiredBy.
	if st := find(t, s.List(), UV); len(st.RequiredBy) != 0 || !st.Managed || st.InstallHint != "Installed with the AI engine" {
		t.Errorf("uv status %+v", st)
	}
}

func TestVersionMatches(t *testing.T) {
	tests := []struct {
		out, tag string
		want     bool
	}{
		{"2026.10.26", "2026.10.26", true},
		{"uv 0.13.6 (abc 2026-10-20)", "0.13.6", true},
		{"uv 0.13.6 (abc 2026-10-20)", "v0.13.6", true},
		{"uv 0.13.5 (abc)", "0.13.6", false},
		{"", "0.13.6", false},
	}
	for _, tc := range tests {
		if got := versionMatches(tc.out, tc.tag); got != tc.want {
			t.Errorf("%q vs %q: %v", tc.out, tc.tag, got)
		}
	}
}

// ---- virtual deps ----

func TestRegisterVirtual(t *testing.T) {
	reg := core.NewRegistry()
	reg.Register(fakeModule{core.Descriptor{ID: "stems", Name: "Stems", Requires: []string{"audio-engine"}, Status: core.StatusReady}})
	reg.Register(fakeModule{core.Descriptor{ID: "other", Name: "Other", Recommends: []string{"audio-engine"}, Status: core.StatusReady}})

	var events []core.DepsChanged
	em := core.EmitterFunc(func(name string, data any) {
		if name == core.EventDepsChanged {
			events = append(events, data.(core.DepsChanged))
		}
	})
	s := New(t.TempDir(), Catalog(), reg, em)
	s.lookPath = noLook
	s.knownDirs = func() []string { return nil }

	state := core.DepMissing
	path := ""
	detects := 0
	s.RegisterVirtual(Spec{
		ID: "audio-engine", Name: "AI engine", Purpose: "Python runtime", Managed: true,
		InstallHint: map[string]string{s.goos: "Install from Settings → Dependencies"},
	}, func(ctx context.Context) core.DepStatus {
		detects++
		return core.DepStatus{ID: "audio-engine", State: state, Path: path, Version: "v1"}
	})

	list := s.List()
	if len(list) != len(Catalog())+1 || list[len(list)-1].ID != "audio-engine" {
		t.Fatalf("list: %d last=%s", len(list), list[len(list)-1].ID)
	}
	ae := list[len(list)-1]
	if ae.State != core.DepMissing || !ae.Managed || ae.Name != "AI engine" ||
		len(ae.RequiredBy) != 1 || ae.RequiredBy[0] != "stems" || !ae.Required ||
		len(ae.RecommendedBy) != 1 || ae.RecommendedBy[0] != "other" {
		t.Errorf("pre-detect: %+v", ae)
	}

	// Missing: Resolve re-detects once, then errors with the hint.
	_, err := s.Resolve("audio-engine")
	if !core.IsCode(err, core.CodeDependencyMissing) || core.AsAppError(err).Hint != "Install from Settings → Dependencies" {
		t.Fatalf("missing: %v", err)
	}
	if detects != 1 {
		t.Errorf("detects=%d", detects)
	}

	// Outdated does not resolve.
	state, path = core.DepOutdated, "/venv/python"
	_, err = s.Resolve("audio-engine")
	if ae := core.AsAppError(err); !core.IsCode(err, core.CodeDependencyMissing) || ae.Message != "The AI engine needs an update" || ae.Hint == "" {
		t.Fatalf("outdated: %+v", ae)
	}

	// OK resolves to the path, then comes from the cache.
	state = core.DepOK
	p, err := s.Resolve("audio-engine")
	if err != nil || p != "/venv/python" {
		t.Fatalf("ok: %q %v", p, err)
	}
	n := detects
	if _, err := s.Resolve("audio-engine"); err != nil || detects != n {
		t.Errorf("not cached: detects %d->%d", n, detects)
	}

	// Detect runs it too and emits deps:changed with the virtual dep included.
	events = nil
	state, path = core.DepOutdated, "/venv/python"
	got := s.Detect(context.Background())
	d := find(t, got, "audio-engine")
	if d.State != core.DepOutdated || d.Version != "v1" || d.CheckedAt == 0 {
		t.Errorf("detect: %+v", d)
	}
	if len(events) != 1 || find(t, events[0].Deps, "audio-engine").State != core.DepOutdated {
		t.Errorf("events: %d", len(events))
	}
}

type fakeModule struct{ d core.Descriptor }

func (f fakeModule) Descriptor() core.Descriptor                 { return f.d }
func (f fakeModule) Validate([]string, json.RawMessage) error    { return nil }
func (f fakeModule) Run(context.Context, *core.JobContext) error { return nil }
