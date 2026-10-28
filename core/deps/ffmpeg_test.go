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
	"strings"
	"sync/atomic"
	"testing"

	"toolbox/core"
)

func TestFFmpegLayoutWindowsKeepsThreeFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ffmpeg-9.0.2-essentials_build")
	writeTree(t, root, map[string]string{
		"bin/ffmpeg.exe": "ff", "bin/ffprobe.exe": "fp", "bin/ffplay.exe": "pl",
		"LICENSE": "gpl", "README.txt": "r", "doc/x.html": "x",
	})
	dir := filepath.Join(t.TempDir(), "ffmpeg")
	if err := ffmpegLayout("windows", map[string]string{"main": root}, dir); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "LICENSE,ffmpeg.exe,ffprobe.exe" {
		t.Errorf("files: %v", names)
	}
	if err := ffmpegLayout("windows", map[string]string{"main": t.TempDir()}, filepath.Join(t.TempDir(), "x")); err == nil {
		t.Error("missing files should fail")
	}
}

func TestFFmpegLayoutDarwinTwoParts(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	writeTree(t, a, map[string]string{"ffmpeg": "ff"})
	writeTree(t, b, map[string]string{"ffprobe": "fp"})
	dir := filepath.Join(t.TempDir(), "ffmpeg")
	if err := ffmpegLayout("darwin", map[string]string{"ffmpeg": a, "ffprobe": b}, dir); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"ffmpeg", "ffprobe"} {
		fi, err := os.Stat(filepath.Join(dir, n))
		if err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o755 {
			t.Errorf("%s mode %v", n, fi.Mode())
		}
	}
}

func TestDenoLayoutAndAssets(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"deno.exe": "d"})
	dir := filepath.Join(t.TempDir(), "deno")
	if err := denoLayout("windows", root, dir); err != nil {
		t.Fatal(err)
	}
	if !isFile(filepath.Join(dir, "deno.exe")) {
		t.Error("deno.exe missing")
	}
	if err := denoLayout("darwin", root, dir); err == nil {
		t.Error("expected missing deno error")
	}
	for _, c := range []struct{ os, arch, want string }{
		{"windows", "amd64", "deno-x86_64-pc-windows-msvc.zip"},
		{"darwin", "arm64", "deno-aarch64-apple-darwin.zip"},
		{"darwin", "amd64", ""},
		{"linux", "amd64", ""},
	} {
		got, err := denoAsset(c.os, c.arch, "")
		if got != c.want || (c.want == "") != (err != nil) {
			t.Errorf("%s/%s: %q %v", c.os, c.arch, got, err)
		}
		if c.want != "" && denoSHA256[got] == "" {
			t.Errorf("no sha for %s", got)
		}
	}
}

func TestPinnedChecksumsLookRight(t *testing.T) {
	for k, v := range map[string]string{"a": ffmpegSHA256[ffmpegWinAsset], "b": ffmpegSHA256["ffmpeg.zip"], "c": ffmpegSHA256["ffprobe.zip"]} {
		if len(v) != 64 {
			t.Errorf("%s: %q", k, v)
		}
	}
}

// A truncated first download is retried once; two bad downloads fail.
func TestChecksumRetry(t *testing.T) {
	data := zipWith(t, map[string]string{"top/exiftool(-k).exe": "x", "top/exiftool_files/p.dll": "d"})
	sum := sha256.Sum256(data)
	want := hex.EncodeToString(sum[:])
	for _, c := range []struct {
		name     string
		badFirst int32 // how many initial responses are corrupt
		wantErr  bool
		hits     int32
	}{
		{"first corrupt", 1, false, 2},
		{"both corrupt", 2, true, 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			var hits atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if n := hits.Add(1); n <= c.badFirst {
					w.Write(data[:len(data)/2])
					return
				}
				w.Write(data)
			}))
			defer srv.Close()
			bin := filepath.Join(t.TempDir(), "bin")
			s := newSvc(t, bin, nil)
			s.goos = "windows"
			i := newArchiveInstaller(s)
			i.goos, i.goarch = "windows", "amd64"
			spec := ExifToolArchive()
			spec.Version = "1.0"
			spec.VersionURL = ""
			spec.Parts[0].URL = func(string) string { return srv.URL + "/a.zip" }
			spec.Parts[0].SHA256 = func(string) string { return want }
			spec.Layout = func(roots map[string]string, dir string) error { return exifToolLayout("windows", roots["main"], dir) }
			i.verify = func(context.Context, string) (string, error) { return "1.0", nil }
			err := i.install(context.Background(), (&progressRec{}).job(t), spec)
			if (err != nil) != c.wantErr {
				t.Fatalf("err %v", err)
			}
			if c.wantErr && core.AsAppError(err).Message != "The download was corrupted — try again" {
				t.Errorf("message %q", core.AsAppError(err).Message)
			}
			if hits.Load() != c.hits {
				t.Errorf("hits %d", hits.Load())
			}
		})
	}
}
