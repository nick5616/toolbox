package deps

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"toolbox/core"
)

func TestExifToolAssets(t *testing.T) {
	tests := []struct{ goos, arch, want string }{
		{"windows", "amd64", "exiftool-13.59_64.zip"},
		{"windows", "arm64", "exiftool-13.59_64.zip"},
		{"windows", "386", ""},
		{"darwin", "arm64", "Image-ExifTool-13.59.tar.gz"},
		{"linux", "amd64", "Image-ExifTool-13.59.tar.gz"},
		{"plan9", "amd64", ""},
	}
	for _, tc := range tests {
		got, err := exifToolAsset(tc.goos, tc.arch, "13.59")
		if tc.want == "" {
			if err == nil {
				t.Errorf("%s/%s: expected error", tc.goos, tc.arch)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s/%s: got %q %v", tc.goos, tc.arch, got, err)
		}
	}
}

func TestFindChecksum(t *testing.T) {
	text := "SHA2-256(Image-ExifTool-13.59.tar.gz)= aaa\r\nSHA2-256(exiftool-13.59_32.zip)= bbb\nSHA1(exiftool-13.59_64.zip)= zzz\nSHA2-256(exiftool-13.59_64.zip)= ccc\n"
	for asset, want := range map[string]string{
		"Image-ExifTool-13.59.tar.gz": "aaa", "exiftool-13.59_32.zip": "bbb",
		"exiftool-13.59_64.zip": "ccc", "missing.zip": "",
	} {
		if got := findChecksum(text, asset); got != want {
			t.Errorf("%s: %q want %q", asset, got, want)
		}
	}
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExifToolLayoutWindows(t *testing.T) {
	ext := filepath.Join(t.TempDir(), "x")
	writeTree(t, ext, map[string]string{
		"exiftool-13.59_64/exiftool(-k).exe":         "13.59",
		"exiftool-13.59_64/exiftool_files/perl5.dll": "dll",
		"exiftool-13.59_64/exiftool_files/lib/a.pm":  "pm",
	})
	dest := filepath.Join(t.TempDir(), "exiftool")
	if err := exifToolLayout("windows", ext, dest); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"exiftool.exe", "exiftool_files/perl5.dll", "exiftool_files/lib/a.pm"} {
		if !isFile(filepath.Join(dest, filepath.FromSlash(f))) {
			t.Errorf("missing %s", f)
		}
	}
	if isFile(filepath.Join(dest, "exiftool(-k).exe")) {
		t.Error("-k exe should be renamed")
	}
	// Missing pieces are errors.
	ext2 := filepath.Join(t.TempDir(), "y")
	writeTree(t, ext2, map[string]string{"exiftool(-k).exe": "x"})
	if err := exifToolLayout("windows", ext2, filepath.Join(t.TempDir(), "d")); err == nil {
		t.Error("expected error without exiftool_files")
	}
}

func TestExifToolLayoutUnix(t *testing.T) {
	ext := filepath.Join(t.TempDir(), "x")
	writeTree(t, ext, map[string]string{
		"Image-ExifTool-13.59/exiftool":       "#!/usr/bin/perl\n",
		"Image-ExifTool-13.59/lib/Image/E.pm": "pm",
		"Image-ExifTool-13.59/README":         "r",
	})
	dest := filepath.Join(t.TempDir(), "exiftool")
	if err := exifToolLayout("linux", ext, dest); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dest, "exiftool"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm()&0o111 == 0 {
		t.Errorf("not executable: %v", fi.Mode())
	}
	if !isFile(filepath.Join(dest, "lib", "Image", "E.pm")) {
		t.Error("lib missing")
	}
	ext2 := filepath.Join(t.TempDir(), "z")
	writeTree(t, ext2, map[string]string{"exiftool": "x"})
	if err := exifToolLayout("linux", ext2, filepath.Join(t.TempDir(), "d")); err == nil {
		t.Error("expected error without lib")
	}
}

func TestSafeJoinAndExtractTraversal(t *testing.T) {
	dest := t.TempDir()
	for _, bad := range []string{"../x", "a/../../x", "/abs", `C:\x`, `..\x`} {
		if _, err := safeJoin(dest, bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
	if p, err := safeJoin(dest, "a/b.txt"); err != nil || p != filepath.Join(dest, "a", "b.txt") {
		t.Errorf("ok path: %q %v", p, err)
	}
	// A hostile tar.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "../evil", Mode: 0o644, Size: 1, Typeflag: tar.TypeReg})
	tw.Write([]byte("x"))
	tw.Close()
	gz.Close()
	arc := filepath.Join(t.TempDir(), "evil.tar.gz")
	os.WriteFile(arc, buf.Bytes(), 0o644)
	if err := extractArchive(context.Background(), arc, "evil.tar.gz", filepath.Join(t.TempDir(), "out"), 1<<20); err == nil {
		t.Error("traversal should fail")
	}
	// A hostile zip.
	zarc := filepath.Join(t.TempDir(), "evil.zip")
	os.WriteFile(zarc, zipWith(t, map[string]string{"../evil": "x"}), 0o644)
	if err := extractArchive(context.Background(), zarc, "evil.zip", filepath.Join(t.TempDir(), "out"), 1<<20); err == nil {
		t.Error("zip traversal should fail")
	}
}

type exifRelease struct {
	srv     *httptest.Server
	version string
	asset   string
	data    []byte
	sum     string // "" = correct
	hits    atomic.Int32
	slow    chan struct{} // when non-nil, asset download blocks until closed/ctx done
}

func newExifRelease(t *testing.T, asset string, data []byte) *exifRelease {
	r := &exifRelease{version: "13.59", asset: asset, data: data}
	mux := http.NewServeMux()
	r.srv = httptest.NewServer(mux)
	t.Cleanup(r.srv.Close)
	mux.HandleFunc("/ver.txt", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, r.version) })
	mux.HandleFunc("/checksums.txt", func(w http.ResponseWriter, _ *http.Request) {
		sum := r.sum
		if sum == "" {
			h := sha256.Sum256(r.data)
			sum = hex.EncodeToString(h[:])
		}
		fmt.Fprintf(w, "SHA1(%s)= 0000\nSHA2-256(%s)= %s\n", r.asset, r.asset, sum)
	})
	mux.HandleFunc("/dl/", func(w http.ResponseWriter, req *http.Request) {
		r.hits.Add(1)
		if r.slow != nil {
			w.Header().Set("Content-Length", fmt.Sprint(len(r.data)))
			w.WriteHeader(200)
			w.Write(r.data[:10])
			w.(http.Flusher).Flush()
			select {
			case <-r.slow:
			case <-req.Context().Done():
			}
			return
		}
		http.Redirect(w, req, "/real/"+strings.TrimPrefix(req.URL.Path, "/dl/"), http.StatusFound)
	})
	mux.HandleFunc("/real/", func(w http.ResponseWriter, _ *http.Request) { w.Write(r.data) })
	return r
}

func (r *exifRelease) spec(goos string) ArchiveSpec {
	a := ExifToolArchive()
	a.VersionURL = r.srv.URL + "/ver.txt"
	a.ChecksumsURL = r.srv.URL + "/checksums.txt"
	a.DownloadURL = func(asset string) string { return r.srv.URL + "/dl/" + asset }
	a.Layout = func(root, dir string) error { return exifToolLayout(goos, root, dir) }
	return a
}

func (r *exifRelease) installer(t *testing.T, goos string) (*archiveInstaller, string) {
	bin := filepath.Join(t.TempDir(), "bin")
	s := newSvc(t, bin, nil)
	s.goos = goos
	i := newArchiveInstaller(s)
	i.goos, i.goarch = goos, "amd64"
	i.havePerl = func() bool { return true }
	i.verify = func(_ context.Context, exe string) (string, error) {
		b, err := os.ReadFile(exe)
		return string(b), err
	}
	return i, bin
}

func winZip(t *testing.T, version string) []byte {
	return zipWith(t, map[string]string{
		"exiftool-" + version + "_64/exiftool(-k).exe":        version,
		"exiftool-" + version + "_64/exiftool_files/perl.dll": "dll",
	})
}

func TestInstallArchiveWindows(t *testing.T) {
	r := newExifRelease(t, "exiftool-13.59_64.zip", winZip(t, "13.59"))
	i, bin := r.installer(t, "windows")
	var rec progressRec
	if err := i.install(context.Background(), rec.job(t), r.spec("windows")); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(bin, "exiftool", "exiftool.exe"))
	if err != nil || string(b) != "13.59" {
		t.Fatalf("exe: %q %v", b, err)
	}
	if !isFile(filepath.Join(bin, "exiftool", "exiftool_files", "perl.dll")) {
		t.Error("exiftool_files missing")
	}
	if rec.msg != "Installed ExifTool 13.59" || rec.pcts[len(rec.pcts)-1] != 1 {
		t.Errorf("final: %q %v", rec.msg, rec.pcts)
	}
	for _, p := range rec.pcts {
		if p > 1 {
			t.Errorf("progress %v", p)
		}
	}
	ents, _ := os.ReadDir(bin)
	if len(ents) != 1 {
		t.Errorf("leftovers in bin: %v", ents)
	}
	// Detected as managed in the archive dir.
	sp, _ := i.svc.spec(ExifTool)
	if p, src := i.svc.find(sp); src != core.SourceManaged || p != filepath.Join(bin, "exiftool", "exiftool.exe") {
		t.Errorf("find: %q %v", p, src)
	}
	// Second run: already up to date, no download.
	hits := r.hits.Load()
	var rec2 progressRec
	if err := i.install(context.Background(), rec2.job(t), r.spec("windows")); err != nil {
		t.Fatal(err)
	}
	if rec2.msg != "Already up to date (13.59)" || r.hits.Load() != hits {
		t.Errorf("up to date: %q hits %d→%d", rec2.msg, hits, r.hits.Load())
	}
}

func TestInstallArchiveUnixTarGz(t *testing.T) {
	asset := "Image-ExifTool-13.59.tar.gz"
	data := tgzWith(t, map[string]string{
		"Image-ExifTool-13.59/exiftool":       "13.59",
		"Image-ExifTool-13.59/lib/Image/E.pm": "pm",
	})
	r := newExifRelease(t, asset, data)
	i, bin := r.installer(t, "linux")
	if err := i.install(context.Background(), (&progressRec{}).job(t), r.spec("linux")); err != nil {
		t.Fatal(err)
	}
	if !isFile(filepath.Join(bin, "exiftool", "exiftool")) || !isFile(filepath.Join(bin, "exiftool", "lib", "Image", "E.pm")) {
		t.Error("layout wrong")
	}
}

func TestInstallArchiveNoPerl(t *testing.T) {
	r := newExifRelease(t, "Image-ExifTool-13.59.tar.gz", []byte("x"))
	i, _ := r.installer(t, "darwin")
	i.havePerl = func() bool { return false }
	err := i.install(context.Background(), (&progressRec{}).job(t), r.spec("darwin"))
	var ae *core.AppError
	if !errors.As(err, &ae) || !strings.Contains(ae.Hint, "brew install exiftool") {
		t.Fatalf("err: %v", err)
	}
	if r.hits.Load() != 0 {
		t.Error("should fail before downloading")
	}
}

// seedOld installs a working "12.00" and returns its exe path.
func seedOld(t *testing.T, bin string) string {
	writeTree(t, filepath.Join(bin, "exiftool"), map[string]string{"exiftool.exe": "12.00", "exiftool_files/old.dll": "o"})
	return filepath.Join(bin, "exiftool", "exiftool.exe")
}

func TestInstallArchiveUpgradeAndFailuresKeepOld(t *testing.T) {
	good := winZip(t, "13.59")
	cases := []struct {
		name  string
		setup func(r *exifRelease, i *archiveInstaller, a *ArchiveSpec)
	}{
		{"checksum mismatch", func(r *exifRelease, _ *archiveInstaller, _ *ArchiveSpec) { r.sum = strings.Repeat("0", 64) }},
		{"verify fails", func(_ *exifRelease, i *archiveInstaller, _ *ArchiveSpec) {
			i.verify = func(_ context.Context, exe string) (string, error) {
				if strings.Contains(exe, ".new") {
					return "", errors.New("boom")
				}
				return "12.00", nil
			}
		}},
		{"wrong version", func(r *exifRelease, _ *archiveInstaller, _ *ArchiveSpec) {
			r.data = winZip(t, "13.58")
			h := sha256.Sum256(r.data)
			r.sum = hex.EncodeToString(h[:])
		}},
		{"layout fails", func(_ *exifRelease, _ *archiveInstaller, a *ArchiveSpec) {
			a.Layout = func(string, string) error { return errors.New("layout") }
		}},
		{"size cap", func(_ *exifRelease, i *archiveInstaller, _ *ArchiveSpec) { i.maxSize = 10 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newExifRelease(t, "exiftool-13.59_64.zip", good)
			i, bin := r.installer(t, "windows")
			oldExe := seedOld(t, bin)
			a := r.spec("windows")
			tc.setup(r, i, &a)
			if err := i.install(context.Background(), (&progressRec{}).job(t), a); err == nil {
				t.Fatal("expected failure")
			}
			b, err := os.ReadFile(oldExe)
			if err != nil || string(b) != "12.00" {
				t.Fatalf("old install damaged: %q %v", b, err)
			}
			ents, _ := os.ReadDir(bin)
			if len(ents) != 1 {
				t.Errorf("leftovers: %v", ents)
			}
		})
	}
	t.Run("upgrade replaces", func(t *testing.T) {
		r := newExifRelease(t, "exiftool-13.59_64.zip", good)
		i, bin := r.installer(t, "windows")
		oldExe := seedOld(t, bin)
		if err := i.install(context.Background(), (&progressRec{}).job(t), r.spec("windows")); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(oldExe)
		if string(b) != "13.59" {
			t.Errorf("not upgraded: %q", b)
		}
		if isFile(filepath.Join(bin, "exiftool", "exiftool_files", "old.dll")) {
			t.Error("old files should be gone")
		}
		ents, _ := os.ReadDir(bin)
		if len(ents) != 1 {
			t.Errorf("leftovers: %v", ents)
		}
	})
}

func TestInstallArchiveCancelMidDownload(t *testing.T) {
	r := newExifRelease(t, "exiftool-13.59_64.zip", winZip(t, "13.59"))
	r.slow = make(chan struct{})
	defer close(r.slow)
	i, bin := r.installer(t, "windows")
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for r.hits.Load() == 0 {
			runtime.Gosched()
		}
		cancel()
	}()
	err := i.install(ctx, (&progressRec{}).job(t), r.spec("windows"))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeCancelled {
		t.Fatalf("err: %v", err)
	}
	if ents, _ := os.ReadDir(bin); len(ents) != 0 {
		t.Errorf("leftovers: %v", ents)
	}
}

func TestExifToolResolutionOrder(t *testing.T) {
	name := "exiftool"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	bin := t.TempDir()
	known := t.TempDir()
	s := newSvc(t, bin, nil, known)
	sp, _ := s.spec(ExifTool)
	if !sp.Managed {
		t.Fatal("exiftool should be managed")
	}
	writeTree(t, known, map[string]string{name: "k"})
	if p, src := s.find(sp); src != core.SourceKnownDir || p != filepath.Join(known, name) {
		t.Errorf("known: %q %v", p, src)
	}
	s.lookPath = func(string) (string, error) { return filepath.Join(known, name), nil }
	if _, src := s.find(sp); src != core.SourcePath {
		t.Errorf("path: %v", src)
	}
	writeTree(t, bin, map[string]string{name: "flat"})
	if p, src := s.find(sp); src != core.SourceManaged || p != filepath.Join(bin, name) {
		t.Errorf("flat: %q %v", p, src)
	}
	writeTree(t, bin, map[string]string{"exiftool/" + name: "dir"})
	if p, src := s.find(sp); src != core.SourceManaged || p != filepath.Join(bin, "exiftool", name) {
		t.Errorf("dir: %q %v", p, src)
	}
}

func TestExifToolUpdaterModule(t *testing.T) {
	reg := core.NewRegistry()
	s := newSvc(t, t.TempDir(), reg)
	if err := RegisterExifToolUpdater(reg, s); err != nil {
		t.Fatal(err)
	}
	m, ok := reg.Get(ExifToolUpdateModuleID)
	if !ok {
		t.Fatal("not registered")
	}
	if d := m.Descriptor(); !d.Hidden || d.MaxConcurrent != 1 {
		t.Errorf("descriptor %+v", d)
	}
	if err := m.Validate([]string{"x"}, nil); err == nil {
		t.Error("inputs should be rejected")
	}
}
