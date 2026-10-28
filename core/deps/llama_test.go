package deps

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLlamaAssets(t *testing.T) {
	a := LlamaArchive()
	if len(a.Parts) != 1 || a.Parts[0].Name != "main" || a.Version != "b11938" || a.VersionURL != "" || a.ModuleID != LlamaInstallModuleID || a.DepID != Llama {
		t.Fatalf("spec = %+v", a)
	}
	tests := []struct{ goos, arch, want string }{
		{"windows", "amd64", "llama-b11938-bin-win-vulkan-x64.zip"},
		{"windows", "arm64", "llama-b11938-bin-win-vulkan-x64.zip"},
		{"darwin", "arm64", "llama-b11938-bin-macos-arm64.tar.gz"},
		{"darwin", "amd64", ""},
		{"linux", "amd64", ""},
		{"windows", "386", ""},
	}
	for _, tc := range tests {
		got, err := a.Parts[0].Asset(tc.goos, tc.arch, LlamaVersion)
		if tc.want == "" {
			if err == nil {
				t.Errorf("%s/%s: expected unsupported", tc.goos, tc.arch)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s/%s: %q %v", tc.goos, tc.arch, got, err)
			continue
		}
		if u := a.Parts[0].URL(got); !strings.HasPrefix(u, "https://github.com/ggml-org/llama.cpp/releases/download/b11938/") {
			t.Errorf("url = %s", u)
		}
		if len(a.Parts[0].SHA256(got)) != 64 {
			t.Errorf("%s: no pinned sha256", got)
		}
	}
	if a.Parts[0].SHA256("llama-b11938-bin-win-vulkan-x64.zip") != "9ecd072c6e785fa2b932229c86f845695198195c4f29b99b85ed42dccb022aa6" ||
		a.Parts[0].SHA256("llama-b11938-bin-macos-arm64.tar.gz") != "b1ed33aacd0927eaa69644e6b15e3206115f7f80dfc7501de86df89dab853e9f" {
		t.Error("pinned sha256 differs from SPEC §0.1")
	}
}

func TestLlamaLayout(t *testing.T) {
	for _, goos := range []string{"windows", "darwin"} {
		t.Run(goos, func(t *testing.T) {
			exe := "llama-server"
			if goos == "windows" {
				exe += ".exe"
			}
			ext := filepath.Join(t.TempDir(), "x")
			writeTree(t, ext, map[string]string{
				"llama-b11938/" + exe:                "stub",
				"llama-b11938/llama-server-impl.dll": "impl",
				"llama-b11938/sub/ggml.dll":          "ggml",
			})
			dir := filepath.Join(t.TempDir(), "llama")
			if err := llamaLayout(goos, ext, dir); err != nil {
				t.Fatal(err)
			}
			for _, f := range []string{exe, "llama-server-impl.dll", "sub/ggml.dll", "LICENSE-llama.cpp"} {
				if !isFile(filepath.Join(dir, filepath.FromSlash(f))) {
					t.Errorf("%s missing", f)
				}
			}
			lic, _ := os.ReadFile(filepath.Join(dir, "LICENSE-llama.cpp"))
			if !strings.HasPrefix(string(lic), "MIT License") {
				t.Error("licence text wrong")
			}
			if runtime.GOOS != "windows" && goos != "windows" {
				fi, _ := os.Stat(filepath.Join(dir, exe))
				if fi.Mode().Perm() != 0o755 {
					t.Errorf("mode = %v", fi.Mode())
				}
			}
		})
	}
	empty := filepath.Join(t.TempDir(), "e")
	writeTree(t, empty, map[string]string{"other": "x"})
	if err := llamaLayout("windows", empty, filepath.Join(t.TempDir(), "d")); err == nil {
		t.Error("expected error without llama-server")
	}
}

func tarGz(t *testing.T, entries []tar.Header, bodies map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, h := range entries {
		h := h
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(bodies[h.Name]))
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			tw.Write([]byte(bodies[h.Name]))
		}
	}
	tw.Close()
	gz.Close()
	p := filepath.Join(t.TempDir(), "a.tar.gz")
	os.WriteFile(p, buf.Bytes(), 0o644)
	return p
}

func symlinkEntries() ([]tar.Header, map[string]string) {
	return []tar.Header{
		{Name: "top/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "top/libx.1.2.dylib", Typeflag: tar.TypeReg},
		// link listed before and chained through another link
		{Name: "top/libx.dylib", Typeflag: tar.TypeSymlink, Linkname: "libx.1.dylib"},
		{Name: "top/libx.1.dylib", Typeflag: tar.TypeSymlink, Linkname: "libx.1.2.dylib"},
	}, map[string]string{"top/libx.1.2.dylib": "LIB"}
}

func TestExtractTarSymlinks(t *testing.T) {
	entries, bodies := symlinkEntries()
	arc := tarGz(t, entries, bodies)

	t.Run("copied as files (windows behaviour)", func(t *testing.T) {
		old := symlinkAsCopy
		symlinkAsCopy = true
		defer func() { symlinkAsCopy = old }()
		dest := filepath.Join(t.TempDir(), "o")
		if err := extractArchive(context.Background(), arc, "a.tar.gz", dest, 1<<20); err != nil {
			t.Fatal(err)
		}
		for _, n := range []string{"libx.dylib", "libx.1.dylib", "libx.1.2.dylib"} {
			b, err := os.ReadFile(filepath.Join(dest, "top", n))
			if err != nil || string(b) != "LIB" {
				t.Errorf("%s: %q %v", n, b, err)
			}
		}
	})

	t.Run("real symlinks", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("needs symlink privileges")
		}
		old := symlinkAsCopy
		symlinkAsCopy = false
		defer func() { symlinkAsCopy = old }()
		dest := filepath.Join(t.TempDir(), "o")
		if err := extractArchive(context.Background(), arc, "a.tar.gz", dest, 1<<20); err != nil {
			t.Fatal(err)
		}
		if l, err := os.Readlink(filepath.Join(dest, "top", "libx.dylib")); err != nil || l != "libx.1.dylib" {
			t.Fatalf("readlink: %q %v", l, err)
		}
		if b, _ := os.ReadFile(filepath.Join(dest, "top", "libx.dylib")); string(b) != "LIB" {
			t.Errorf("read through link: %q", b)
		}
	})
}

func TestExtractTarSymlinkEscapes(t *testing.T) {
	for _, target := range []string{"/etc/passwd", "../../outside", "../../../x", `C:\Windows`, "a/../../../x"} {
		for _, asCopy := range []bool{true, false} {
			old := symlinkAsCopy
			symlinkAsCopy = asCopy
			arc := tarGz(t, []tar.Header{{Name: "top/link", Typeflag: tar.TypeSymlink, Linkname: target}}, nil)
			err := extractArchive(context.Background(), arc, "a.tar.gz", filepath.Join(t.TempDir(), "o"), 1<<20)
			symlinkAsCopy = old
			if err == nil || !strings.Contains(err.Error()+errCause(err), "unsafe archive") {
				t.Errorf("target %q (copy=%v): err = %v", target, asCopy, err)
			}
		}
	}
	// A relative link that stays inside is fine.
	arc := tarGz(t, []tar.Header{
		{Name: "top/a/f", Typeflag: tar.TypeReg},
		{Name: "top/b/link", Typeflag: tar.TypeSymlink, Linkname: "../a/f"},
	}, map[string]string{"top/a/f": "F"})
	old := symlinkAsCopy
	symlinkAsCopy = true
	defer func() { symlinkAsCopy = old }()
	dest := filepath.Join(t.TempDir(), "o")
	if err := extractArchive(context.Background(), arc, "a.tar.gz", dest, 1<<20); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "top", "b", "link")); string(b) != "F" {
		t.Errorf("link copy = %q", b)
	}
}

func errCause(err error) string {
	if u, ok := err.(interface{ Unwrap() error }); ok && u.Unwrap() != nil {
		return u.Unwrap().Error()
	}
	return ""
}
