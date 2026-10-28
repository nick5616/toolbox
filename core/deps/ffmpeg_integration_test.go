//go:build integration

package deps

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

func dirSize(t *testing.T, dir string) (n int64, files []string) {
	t.Helper()
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		n += fi.Size()
		files = append(files, d.Name())
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return n, files
}

// TestRealFFmpegAndDenoInstall downloads the pinned FFmpeg and Deno from their
// real URLs into a temp bin dir (TOOLBOX_SMOKE_DIR, default a temp dir), then
// runs them. Network and ~250 MB of disk.
func TestRealFFmpegAndDenoInstall(t *testing.T) {
	root := os.Getenv("TOOLBOX_SMOKE_DIR")
	if root == "" {
		root = t.TempDir()
	}
	bin := filepath.Join(root, "bin")
	_ = os.RemoveAll(bin)
	svc := New(bin, Catalog(), core.NewRegistry(), core.NopEmitter{})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	for _, c := range []struct {
		name string
		spec ArchiveSpec
		dir  string
		exes []string
	}{
		{"ffmpeg", FFmpegArchive(), "ffmpeg", []string{"ffmpeg", "ffprobe"}},
		{"deno", DenoArchive(), "deno", []string{"deno"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			job := core.NewJobContext(core.JobContext{ID: "smoke", TempDir: t.TempDir()}, core.JobHooks{
				Progress: func(pct float64, msg string) {},
				Log:      func(_ core.LogStream, l string) { t.Log(l) },
			})
			start := time.Now()
			if err := svc.InstallManagedArchive(ctx, job, c.spec); err != nil {
				t.Fatal(err)
			}
			size, files := dirSize(t, filepath.Join(bin, c.dir))
			t.Logf("%s installed in %s: %d bytes on disk, files %v", c.name, time.Since(start).Round(time.Second), size, files)
			for _, exe := range c.exes {
				name := exe
				if svc.goos == "windows" {
					name += ".exe"
				}
				p := filepath.Join(bin, c.dir, name)
				arg := "-version"
				if exe == "deno" {
					arg = "--version"
				}
				out, err := proc.Output(ctx, 20*time.Second, p, arg)
				if err != nil {
					t.Fatalf("%s: %v", exe, err)
				}
				t.Logf("%s: %.60s", exe, out)
			}
			sp, _ := svc.spec(c.spec.DepID)
			if p, src := svc.find(sp); src != core.SourceManaged {
				t.Errorf("not detected as managed: %q %v", p, src)
			}
			// A second run is a no-op.
			if err := svc.InstallManagedArchive(ctx, job, c.spec); err != nil {
				t.Fatal(err)
			}
		})
	}
	st := svc.Detect(ctx)
	for _, d := range st {
		if (d.ID == FFmpeg || d.ID == FFprobe || d.ID == Deno) && (d.State != core.DepOK || d.Source != core.SourceManaged) {
			t.Errorf("%s: state %s source %s", d.ID, d.State, d.Source)
		}
	}
}
