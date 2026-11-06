package deps

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ulikunitz/xz"

	"toolbox/core"
)

// Phase 12: Pandoc, Typst and Monolith.

func TestDocumentToolAssets(t *testing.T) {
	type assetFn func(goos, goarch, version string) (string, error)
	for _, tool := range []struct {
		name   string
		asset  assetFn
		sha    map[string]string
		sizes  map[string]int64
		base   string
		want   map[string]string // goos/goarch → asset
		prefix string
	}{
		{"pandoc", pandocAsset, pandocSHA256, pandocSizes, pandocBase, map[string]string{
			"windows/amd64": "pandoc-3.13-windows-x86_64.zip",
			"windows/arm64": "pandoc-3.13-windows-x86_64.zip",
			"darwin/arm64":  "pandoc-3.13-arm64-macOS.zip",
		}, "https://github.com/jgm/pandoc/releases/download/3.13/"},
		{"typst", typstAsset, typstSHA256, typstSizes, typstBase, map[string]string{
			"windows/amd64": "typst-x86_64-pc-windows-msvc.zip",
			"darwin/arm64":  "typst-aarch64-apple-darwin.tar.xz",
		}, "https://github.com/typst/typst/releases/download/v0.15.1/"},
		{"monolith", monolithAsset, monolithSHA256, monolithSizes, monolithBase, map[string]string{
			"windows/amd64": "monolith-cli.exe",
			"darwin/arm64":  "monolith-cli-macos-aarch64-apple-darwin",
		}, "https://github.com/Y2Z/monolith/releases/download/v2.12.0/"},
	} {
		t.Run(tool.name, func(t *testing.T) {
			if tool.base != tool.prefix {
				t.Errorf("base %q", tool.base)
			}
			for key, want := range tool.want {
				parts := strings.Split(key, "/")
				got, err := tool.asset(parts[0], parts[1], "")
				if err != nil || got != want {
					t.Errorf("%s: %q %v", key, got, err)
				}
				if len(tool.sha[got]) != 64 {
					t.Errorf("%s: sha %q", got, tool.sha[got])
				}
				if tool.sizes[got] < 1_000_000 {
					t.Errorf("%s: size %d", got, tool.sizes[got])
				}
			}
			for _, key := range []string{"darwin/amd64", "linux/amd64", "linux/arm64", "windows/386"} {
				parts := strings.Split(key, "/")
				if got, err := tool.asset(parts[0], parts[1], ""); err == nil || got != "" {
					t.Errorf("%s should be unsupported: %q %v", key, got, err)
				}
			}
		})
	}
	// Spot-check pins against the release pages.
	if pandocSHA256[pandocWinAsset] != "23e1f2e978a3df80db8bf65c9c59534f41a23140480cfb4f783a882ab7dc6a4e" ||
		typstSHA256[typstMacAsset] != "48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a" ||
		monolithSHA256[monolithWinAsset] != "ed21a1062e3c07f4bed05e4bfccaa872aa2a36ac07aa0eb0de807ea956953eed" {
		t.Error("pinned digest changed")
	}
	if pandocSizes[pandocWinAsset] != 42_983_200 || typstSizes[typstWinAsset] != 22_463_684 || monolithSizes[monolithWinAsset] != 5_539_328 {
		t.Error("pinned size changed")
	}
}

func TestDocumentToolSpecs(t *testing.T) {
	for _, c := range []struct {
		spec ArchiveSpec
		id   string
		mod  string
		raw  bool
	}{
		{PandocArchive(), Pandoc, PandocInstallModuleID, false},
		{TypstArchive(), Typst, TypstInstallModuleID, false},
		{MonolithArchive(), Monolith, MonolithInstallModuleID, true},
	} {
		if c.spec.DepID != c.id || c.spec.ModuleID != c.mod || c.spec.Version == "" || c.spec.InstallDir != c.id {
			t.Errorf("%s: %+v", c.id, c.spec)
		}
		if len(c.spec.Parts) != 1 || c.spec.Parts[0].Raw != c.raw {
			t.Errorf("%s: parts %+v", c.id, c.spec.Parts)
		}
		reg := core.NewRegistry()
		s := newSvc(t, t.TempDir(), reg)
		var err error
		switch c.id {
		case Pandoc:
			err = RegisterPandocInstaller(reg, s)
		case Typst:
			err = RegisterTypstInstaller(reg, s)
		default:
			err = RegisterMonolithInstaller(reg, s)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := reg.Get(c.mod); !ok {
			t.Errorf("%s installer not registered", c.id)
		}
		sp, ok := s.spec(c.id)
		if !ok || !sp.Managed || sp.ArchiveDir != c.id || sp.VersionFile != "VERSION" || sp.PinnedVersion != c.spec.Version {
			t.Errorf("%s catalog: %+v", c.id, sp)
		}
		if sp.AllowSystem != (c.id != Monolith) {
			t.Errorf("%s AllowSystem = %v", c.id, sp.AllowSystem)
		}
	}
}

func TestDocumentToolLayouts(t *testing.T) {
	t.Run("pandoc windows", func(t *testing.T) {
		root := t.TempDir()
		writeTree(t, root, map[string]string{"pandoc.exe": "p", "MANUAL.html": "m", "COPYING.rtf": "c"})
		dir := filepath.Join(t.TempDir(), "pandoc")
		if err := pandocLayout("windows", root, dir); err != nil {
			t.Fatal(err)
		}
		ents, _ := os.ReadDir(dir)
		if len(ents) != 1 || ents[0].Name() != "pandoc.exe" {
			t.Errorf("installed %v", ents)
		}
	})
	t.Run("pandoc darwin keeps only bin/pandoc", func(t *testing.T) {
		root := t.TempDir()
		writeTree(t, root, map[string]string{
			"bin/pandoc": "p", "bin/pandoc-server": "s", "bin/pandoc-lua": "l", "share/man/man1/pandoc.1": "m",
		})
		dir := filepath.Join(t.TempDir(), "pandoc")
		if err := pandocLayout("darwin", root, dir); err != nil {
			t.Fatal(err)
		}
		ents, _ := os.ReadDir(dir)
		if len(ents) != 1 || ents[0].Name() != "pandoc" {
			t.Errorf("installed %v", ents)
		}
		if err := pandocLayout("windows", root, filepath.Join(t.TempDir(), "x")); err == nil {
			t.Error("windows layout of a mac tree should fail")
		}
	})
	t.Run("typst", func(t *testing.T) {
		root := t.TempDir()
		writeTree(t, root, map[string]string{"typst.exe": "t", "typst": "t", "LICENSE": "l", "README.md": "r"})
		for _, goos := range []string{"windows", "darwin"} {
			dir := filepath.Join(t.TempDir(), "typst")
			if err := typstLayout(goos, root, dir); err != nil {
				t.Fatal(err)
			}
			ents, _ := os.ReadDir(dir)
			want := "typst"
			if goos == "windows" {
				want += ".exe"
			}
			if len(ents) != 1 || ents[0].Name() != want {
				t.Errorf("%s: installed %v", goos, ents)
			}
		}
		if err := typstLayout("darwin", t.TempDir(), filepath.Join(t.TempDir(), "x")); err == nil {
			t.Error("expected missing typst error")
		}
	})
	t.Run("monolith", func(t *testing.T) {
		for _, c := range []struct{ goos, arch, asset, want string }{
			{"windows", "amd64", "monolith-cli.exe", "monolith.exe"},
			{"darwin", "arm64", "monolith-cli-macos-aarch64-apple-darwin", "monolith"},
		} {
			root := t.TempDir()
			writeTree(t, root, map[string]string{c.asset: "m"})
			dir := filepath.Join(t.TempDir(), "monolith")
			if err := monolithLayout(c.goos, c.arch, root, dir); err != nil {
				t.Fatal(err)
			}
			if !isFile(filepath.Join(dir, c.want)) {
				t.Errorf("%s: %s missing", c.goos, c.want)
			}
		}
		if err := monolithLayout("windows", "amd64", t.TempDir(), filepath.Join(t.TempDir(), "x")); err == nil {
			t.Error("expected missing asset error")
		}
		if err := monolithLayout("linux", "amd64", t.TempDir(), filepath.Join(t.TempDir(), "x")); err == nil {
			t.Error("expected unsupported platform error")
		}
	})
}

// A zip's symlink entries (Pandoc's macOS zip) are skipped, never created.
func TestZipExtractionSkipsSymlinks(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, mode os.FileMode, body string) {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	add("pandoc-3.13-arm64/bin/pandoc", 0o755, "real")
	add("pandoc-3.13-arm64/bin/pandoc-server", os.ModeSymlink|0o755, "pandoc")
	add("pandoc-3.13-arm64/bin/pandoc-lua", os.ModeSymlink|0o755, "pandoc")
	add("pandoc-3.13-arm64/escape", os.ModeSymlink|0o755, "../../../etc/passwd")
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "p.zip")
	if err := os.WriteFile(archive, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "x")
	if err := extractArchive(context.Background(), archive, "p.zip", dest, 1<<20); err != nil {
		t.Fatal(err)
	}
	root := archiveRoot(dest)
	for _, n := range []string{"pandoc-server", "pandoc-lua"} {
		if _, err := os.Lstat(filepath.Join(root, "bin", n)); err == nil {
			t.Errorf("%s was extracted", n)
		}
	}
	if _, err := os.Lstat(filepath.Join(root, "escape")); err == nil {
		t.Error("escaping symlink was extracted")
	}
	out := filepath.Join(t.TempDir(), "pandoc")
	if err := pandocLayout("darwin", root, out); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "pandoc")); string(b) != "real" {
		t.Errorf("pandoc content %q", b)
	}
	ents, _ := os.ReadDir(out)
	if len(ents) != 1 {
		t.Errorf("installed %v", ents)
	}
}

func txzWith(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	xw, err := xz.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(xw)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(body))
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := xw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractTarXz(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "typst.tar.xz")
	data := txzWith(t, map[string]string{
		"typst-aarch64-apple-darwin/typst":   "binary",
		"typst-aarch64-apple-darwin/LICENSE": "lic",
	})
	if err := os.WriteFile(archive, data, 0o644); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "x")
	if err := extractArchive(context.Background(), archive, "typst.tar.xz", dest, 1<<20); err != nil {
		t.Fatal(err)
	}
	root := archiveRoot(dest)
	if b, _ := os.ReadFile(filepath.Join(root, "typst")); string(b) != "binary" {
		t.Errorf("typst content %q", b)
	}
	if err := typstLayout("darwin", root, filepath.Join(t.TempDir(), "typst")); err != nil {
		t.Fatal(err)
	}
	// Garbage and oversize are errors, not panics.
	bad := filepath.Join(t.TempDir(), "bad.tar.xz")
	os.WriteFile(bad, []byte("not xz data at all"), 0o644)
	if err := extractArchive(context.Background(), bad, "bad.tar.xz", filepath.Join(t.TempDir(), "y"), 1<<20); err == nil {
		t.Error("expected error for a corrupt archive")
	}
	if err := extractArchive(context.Background(), archive, "typst.tar.xz", filepath.Join(t.TempDir(), "z"), 4); err == nil {
		t.Error("expected size limit error")
	}
}

// A Raw part is downloaded, verified and moved; nothing is extracted.
func TestInstallRawPart(t *testing.T) {
	body := []byte("MZ-pretend-monolith-binary")
	sum := sha256.Sum256(body)
	want := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write(body) }))
	defer srv.Close()

	bin := filepath.Join(t.TempDir(), "bin")
	s := newSvc(t, bin, nil)
	s.goos = "windows"
	i := newArchiveInstaller(s)
	i.goos, i.goarch = "windows", "amd64"
	spec := MonolithArchive()
	spec.Parts[0].URL = func(string) string { return srv.URL + "/m" }
	spec.Parts[0].SHA256 = func(string) string { return want }
	spec.Layout = func(roots map[string]string, dir string) error {
		return monolithLayout("windows", "amd64", roots["main"], dir)
	}
	if err := i.install(context.Background(), (&progressRec{}).job(t), spec); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(bin, "monolith", "monolith.exe")
	if b, _ := os.ReadFile(exe); !bytes.Equal(b, body) {
		t.Errorf("installed content %q", b)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(exe); fi.Mode().Perm() != 0o755 {
			t.Errorf("mode %v", fi.Mode())
		}
	}
	if v := readVersionFile(filepath.Join(bin, "monolith")); v != MonolithVersion {
		t.Errorf("VERSION %q", v)
	}
	if p, src := s.find(specOf(t, s, Monolith)); p != exe || src != core.SourceManaged {
		t.Errorf("find: %q %v", p, src)
	}
	// A wrong digest fails and leaves nothing installed.
	bin2 := filepath.Join(t.TempDir(), "bin")
	s2 := newSvc(t, bin2, nil)
	s2.goos = "windows"
	i2 := newArchiveInstaller(s2)
	i2.goos, i2.goarch = "windows", "amd64"
	spec.Parts[0].SHA256 = func(string) string { return strings.Repeat("0", 64) }
	if err := i2.install(context.Background(), (&progressRec{}).job(t), spec); err == nil {
		t.Fatal("expected checksum failure")
	}
	if isFile(filepath.Join(bin2, "monolith", "monolith.exe")) {
		t.Error("a failed install left a binary")
	}
}

func specOf(t *testing.T, s *Service, id string) Spec {
	t.Helper()
	sp, ok := s.spec(id)
	if !ok {
		t.Fatalf("no spec %s", id)
	}
	return sp
}

func TestVersionLess(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"0.11.1", "0.12", true}, {"0.12", "0.12", false}, {"0.12.0", "0.12", false},
		{"0.15.1", "0.12", false}, {"0.9.9", "0.12", true}, {"1.0", "0.12", false},
		{"0.12.0-rc1", "0.12", false}, {"v0.11", "0.12", true}, {"0", "0.12", true},
	} {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

// A system Typst older than 0.12 doesn't count; the managed copy wins.
func TestTypstVersionGate(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		out     string
		wantOK  bool
		version string
	}{
		{"typst 0.11.1 (abcdef12)", false, ""},
		{"typst 0.12.0 (abcdef12)", true, "0.12.0"},
		{"typst 0.15.1 (abcdef12)", true, "0.15.1"},
	} {
		t.Run(c.out, func(t *testing.T) {
			t.Setenv("DEPS_FAKE", "1")
			t.Setenv("DEPS_FAKE_TYPST", c.out)
			sys := t.TempDir()
			fakeTool(t, sys, "typst")
			s := newSvc(t, t.TempDir(), nil, sys)
			st := s.detectOne(ctx, specOf(t, s, Typst))
			if c.wantOK {
				if st.State != core.DepOK || st.Version != c.version || st.Source != core.SourceKnownDir {
					t.Errorf("want ok: %+v", st)
				}
				return
			}
			if st.State != core.DepMissing || st.Path != "" || st.Source != core.SourceNone ||
				!strings.Contains(st.Error, "too old") || st.InstallHint == "" {
				t.Errorf("want missing: %+v", st)
			}
			if _, err := s.Resolve(Typst); !core.IsCode(err, core.CodeDependencyMissing) {
				t.Errorf("Resolve: %v", err)
			}
		})
	}

	// The managed copy is used even with an old system copy beside it.
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_TYPST", "typst 0.11.1")
	sys, bin := t.TempDir(), t.TempDir()
	fakeTool(t, sys, "typst")
	dir := filepath.Join(bin, "typst")
	fakeTool(t, dir, "typst")
	if err := os.WriteFile(filepath.Join(dir, "VERSION"), []byte(TypstVersion+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := newSvc(t, bin, nil, sys)
	st := s.detectOne(ctx, specOf(t, s, Typst))
	if st.State != core.DepOK || st.Source != core.SourceManaged || st.Version != TypstVersion {
		t.Errorf("managed: %+v", st)
	}
}

func TestDocumentToolVersionRegexes(t *testing.T) {
	specs := map[string]Spec{}
	for _, sp := range Catalog() {
		specs[sp.ID] = sp
	}
	for _, c := range []struct{ id, out, want string }{
		{Pandoc, "pandoc 3.13\nFeatures: +server +lua\nScripting engine: Lua 5.4", "3.13"},
		{Pandoc, "pandoc.exe 3.8.1\nFeatures: +server", "3.8.1"},
		{Typst, "typst 0.15.1 (1a2b3c4d)", "0.15.1"},
		{Monolith, "monolith 2.12.0", "2.12.0"},
	} {
		if got := parseVersion(specs[c.id], c.out); got != c.want {
			t.Errorf("%s: %q want %q", c.id, got, c.want)
		}
	}
}
