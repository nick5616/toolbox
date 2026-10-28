package deps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"toolbox/core"
)

func TestUpscaylAssets(t *testing.T) {
	tests := []struct{ goos, arch, want string }{
		{"windows", "amd64", "upscayl-bin-20251207-174704-windows.zip"},
		{"windows", "arm64", "upscayl-bin-20251207-174704-windows.zip"},
		{"windows", "386", ""},
		{"darwin", "arm64", "upscayl-bin-20251207-174704-macos.zip"},
		{"darwin", "amd64", "upscayl-bin-20251207-174704-macos.zip"},
		{"linux", "amd64", ""},
	}
	a := UpscaylArchive()
	if len(a.Parts) != 2 || a.Parts[0].Name != "main" || a.Parts[1].Name != "models" || a.Version != UpscaylVersion || a.VersionURL != "" {
		t.Fatalf("spec shape: %+v", a)
	}
	for _, tc := range tests {
		got, err := a.Parts[0].Asset(tc.goos, tc.arch, UpscaylVersion)
		if got != tc.want || (tc.want == "") != (err != nil) {
			t.Errorf("%s/%s: %q, %v (want %q)", tc.goos, tc.arch, got, err, tc.want)
		}
		if tc.want != "" {
			if !strings.HasPrefix(a.Parts[0].URL(got), "https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/") {
				t.Errorf("url %s", a.Parts[0].URL(got))
			}
			if len(a.Parts[0].SHA256(got)) != 64 {
				t.Errorf("no pinned sha for %s", got)
			}
		}
		// Models come from the Windows zip on every OS.
		m, err := a.Parts[1].Asset(tc.goos, tc.arch, UpscaylVersion)
		if err != nil || m != "realesrgan-ncnn-vulkan-20220424-windows.zip" {
			t.Errorf("models asset %q %v", m, err)
		}
	}
	if u := a.Parts[1].URL("realesrgan-ncnn-vulkan-20220424-windows.zip"); u != "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip" {
		t.Errorf("models url %s", u)
	}
	if a.Parts[1].SHA256("realesrgan-ncnn-vulkan-20220424-windows.zip") != "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d" {
		t.Error("models sha")
	}
}

func upscaylFixtures(t *testing.T) (main, models map[string]string) {
	main = map[string]string{
		"upscayl-bin-20251207-174704-windows/upscayl-bin.exe": "exe",
		"upscayl-bin-20251207-174704-windows/LICENSE":         "agpl",
		"upscayl-bin-20251207-174704-windows/README.md":       "readme",
	}
	models = map[string]string{
		"realesrgan-ncnn-vulkan.exe": "old exe",
		"vcomp140.dll":               "dll",
		"vcomp140d.dll":              "debug dll",
		"models/extra-model.bin":     "x",
		"input.jpg":                  "jpg",
	}
	for _, n := range UpscaylModelNames {
		models["models/"+n+".param"] = "p-" + n
		models["models/"+n+".bin"] = "b-" + n
	}
	return main, models
}

func TestUpscaylLayout(t *testing.T) {
	for _, goos := range []string{"windows", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			main, models := upscaylFixtures(t)
			if goos == "darwin" {
				main = map[string]string{
					"upscayl-bin-20251207-174704-macos/upscayl-bin": "exe",
					"upscayl-bin-20251207-174704-macos/LICENSE":     "agpl",
				}
			}
			mRoot, dRoot := filepath.Join(t.TempDir(), "m"), filepath.Join(t.TempDir(), "d")
			writeTree(t, mRoot, main)
			writeTree(t, dRoot, models)
			dir := filepath.Join(t.TempDir(), "out")
			roots := map[string]string{"main": archiveRoot(mRoot), "models": archiveRoot(dRoot)}
			if err := upscaylLayout(goos, roots, dir); err != nil {
				t.Fatal(err)
			}
			var got []string
			filepath.WalkDir(dir, func(p string, d os.DirEntry, _ error) error {
				if !d.IsDir() {
					rel, _ := filepath.Rel(dir, p)
					got = append(got, filepath.ToSlash(rel))
				}
				return nil
			})
			slices.Sort(got)
			want := []string{"LICENSE-upscayl"}
			exe := "upscayl-bin"
			if goos == "windows" {
				exe += ".exe"
				want = append(want, "vcomp140.dll")
			}
			want = append(want, exe)
			for _, n := range UpscaylModelNames {
				want = append(want, "models/"+n+".bin", "models/"+n+".param")
			}
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Fatalf("files:\n got %v\nwant %v", got, want)
			}
			if runtime.GOOS != "windows" {
				if fi, _ := os.Stat(filepath.Join(dir, exe)); fi.Mode().Perm()&0o111 == 0 {
					t.Errorf("binary not executable: %v", fi.Mode())
				}
			}
		})
	}
	t.Run("missing model", func(t *testing.T) {
		main, models := upscaylFixtures(t)
		delete(models, "models/realesrgan-x4plus.bin")
		mRoot, dRoot := t.TempDir(), t.TempDir()
		writeTree(t, mRoot, main)
		writeTree(t, dRoot, models)
		err := upscaylLayout("windows", map[string]string{"main": archiveRoot(mRoot), "models": dRoot}, filepath.Join(t.TempDir(), "o"))
		if err == nil {
			t.Fatal("expected error")
		}
	})
}

type upscaylRelease struct {
	srv      *httptest.Server
	mainZip  []byte
	modelZip []byte
	hits     atomic.Int32
}

func newUpscaylRelease(t *testing.T) *upscaylRelease {
	main, models := upscaylFixtures(t)
	r := &upscaylRelease{mainZip: zipWith(t, main), modelZip: zipWith(t, models)}
	mux := http.NewServeMux()
	r.srv = httptest.NewServer(mux)
	t.Cleanup(r.srv.Close)
	mux.HandleFunc("/main.zip", func(w http.ResponseWriter, _ *http.Request) { r.hits.Add(1); w.Write(r.mainZip) })
	mux.HandleFunc("/models.zip", func(w http.ResponseWriter, _ *http.Request) { r.hits.Add(1); w.Write(r.modelZip) })
	return r
}

func hexSum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func (r *upscaylRelease) spec(modelsSum string) ArchiveSpec {
	a := UpscaylArchive()
	a.Parts[0].URL = func(string) string { return r.srv.URL + "/main.zip" }
	a.Parts[0].SHA256 = func(string) string { return hexSum(r.mainZip) }
	a.Parts[1].URL = func(string) string { return r.srv.URL + "/models.zip" }
	if modelsSum == "" {
		modelsSum = hexSum(r.modelZip)
	}
	a.Parts[1].SHA256 = func(string) string { return modelsSum }
	a.Layout = func(roots map[string]string, dir string) error { return upscaylLayout("windows", roots, dir) }
	return a
}

func upscaylInstaller(t *testing.T) (*archiveInstaller, string) {
	bin := filepath.Join(t.TempDir(), "bin")
	s := newSvc(t, bin, nil)
	s.goos = "windows"
	i := newArchiveInstaller(s)
	i.goos, i.goarch = "windows", "amd64"
	i.verify = func(context.Context, string) (string, error) {
		t.Error("pinned installs are not run to verify")
		return "", nil
	}
	return i, bin
}

func TestInstallUpscaylTwoParts(t *testing.T) {
	r := newUpscaylRelease(t)
	i, bin := upscaylInstaller(t)
	var rec progressRec
	if err := i.install(context.Background(), rec.job(t), r.spec("")); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(bin, "upscaler")
	if b, _ := os.ReadFile(filepath.Join(dir, "VERSION")); strings.TrimSpace(string(b)) != UpscaylVersion {
		t.Errorf("VERSION %q", b)
	}
	for _, f := range []string{"upscayl-bin.exe", "vcomp140.dll", "LICENSE-upscayl", "models/realesrgan-x4plus.bin"} {
		if !isFile(filepath.Join(dir, f)) {
			t.Errorf("%s missing", f)
		}
	}
	if isFile(filepath.Join(dir, "models", "extra-model.bin")) {
		t.Error("extra model kept")
	}
	for k := 1; k < len(rec.pcts); k++ {
		if rec.pcts[k] < rec.pcts[k-1] && rec.pcts[k] >= 0 && rec.pcts[k-1] >= 0 {
			t.Errorf("progress went backwards: %v", rec.pcts)
			break
		}
	}
	if rec.msg != "Installed Upscaler engine "+UpscaylVersion || rec.pcts[len(rec.pcts)-1] != 1 {
		t.Errorf("final %q", rec.msg)
	}
	if ents, _ := os.ReadDir(bin); len(ents) != 1 {
		t.Errorf("leftovers: %v", ents)
	}

	// Detected as OK with the pinned version.
	i.svc.Detect(context.Background())
	st := find(t, i.svc.List(), Upscayl)
	if st.State != core.DepOK || st.Version != UpscaylVersion || st.Source != core.SourceManaged {
		t.Errorf("status %+v", st)
	}
	if p, err := i.svc.Resolve(Upscayl); err != nil || p != filepath.Join(dir, "upscayl-bin.exe") {
		t.Errorf("resolve %q %v", p, err)
	}

	// Matching VERSION: no network traffic.
	hits := r.hits.Load()
	var rec2 progressRec
	if err := i.install(context.Background(), rec2.job(t), r.spec("")); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(rec2.msg, "Already up to date") || r.hits.Load() != hits {
		t.Errorf("not skipped: %q hits %d→%d", rec2.msg, hits, r.hits.Load())
	}
}

func TestInstallUpscaylBadPartKeepsOld(t *testing.T) {
	r := newUpscaylRelease(t)
	i, bin := upscaylInstaller(t)
	writeTree(t, filepath.Join(bin, "upscaler"), map[string]string{"upscayl-bin.exe": "old", "VERSION": "old-version\n"})
	err := i.install(context.Background(), (&progressRec{}).job(t), r.spec(strings.Repeat("0", 64)))
	var ae *core.AppError
	if err == nil || !strings.Contains(err.Error(), "Checksum mismatch") {
		t.Fatalf("err %v %v", err, ae)
	}
	if b, _ := os.ReadFile(filepath.Join(bin, "upscaler", "upscayl-bin.exe")); string(b) != "old" {
		t.Error("old install damaged")
	}
	if ents, _ := os.ReadDir(bin); len(ents) != 1 {
		t.Errorf("leftovers: %v", ents)
	}
	// An older VERSION is replaced by a good install.
	if err := i.install(context.Background(), (&progressRec{}).job(t), r.spec("")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(bin, "upscaler", "VERSION")); strings.TrimSpace(string(b)) != UpscaylVersion {
		t.Errorf("VERSION %q", b)
	}
}

func TestUpscaylDetectionOutdated(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "bin")
	s := newSvc(t, bin, nil)
	s.goos = "windows"
	// A binary on PATH or in a known dir is not the managed archive.
	known := t.TempDir()
	writeTree(t, known, map[string]string{"upscayl-bin.exe": "x"})
	s.knownDirs = func() []string { return []string{known} }
	if st := s.detectOne(context.Background(), mustSpec(t, s)); st.State != core.DepMissing {
		t.Errorf("external binary: %+v", st)
	}
	dir := filepath.Join(bin, "upscaler")
	writeTree(t, dir, map[string]string{"upscayl-bin.exe": "x"})
	if st := s.detectOne(context.Background(), mustSpec(t, s)); st.State != core.DepOutdated {
		t.Errorf("no VERSION: %+v", st)
	}
	writeTree(t, dir, map[string]string{"VERSION": "20240101-000000+models-0.2.5.0\n"})
	st := s.detectOne(context.Background(), mustSpec(t, s))
	if st.State != core.DepOutdated || st.Version != "20240101-000000+models-0.2.5.0" || st.Path == "" {
		t.Errorf("old VERSION: %+v", st)
	}
	s.Detect(context.Background())
	if _, err := s.Resolve(Upscayl); err == nil {
		t.Error("outdated dep must not resolve")
	}
	writeTree(t, dir, map[string]string{"VERSION": UpscaylVersion})
	if st := s.detectOne(context.Background(), mustSpec(t, s)); st.State != core.DepOK || st.Version != UpscaylVersion {
		t.Errorf("current: %+v", st)
	}
}

func mustSpec(t *testing.T, s *Service) Spec {
	t.Helper()
	sp, ok := s.spec(Upscayl)
	if !ok {
		t.Fatal("no upscayl spec")
	}
	return sp
}

func TestUpscalerInstallerModule(t *testing.T) {
	reg := core.NewRegistry()
	s := newSvc(t, t.TempDir(), reg)
	if err := RegisterUpscalerInstaller(reg, s); err != nil {
		t.Fatal(err)
	}
	m, ok := reg.Get(UpscalerInstallModuleID)
	if !ok {
		t.Fatal("not registered")
	}
	if d := m.Descriptor(); !d.Hidden || d.MaxConcurrent != 1 || d.ID != UpscalerInstallModuleID {
		t.Errorf("descriptor %+v", d)
	}
	if err := m.Validate([]string{"x"}, nil); err == nil {
		t.Error("inputs should be rejected")
	}
	// ExifTool's updater keeps its own ID.
	reg2 := core.NewRegistry()
	if err := RegisterExifToolUpdater(reg2, newSvc(t, t.TempDir(), reg2)); err != nil {
		t.Fatal(err)
	}
	if _, ok := reg2.Get(ExifToolUpdateModuleID); !ok {
		t.Error("exiftool updater id")
	}
}
