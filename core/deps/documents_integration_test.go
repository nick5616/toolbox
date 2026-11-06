//go:build integration

package deps

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

// TestRealDocumentToolsInstall downloads the pinned Pandoc, Typst and Monolith
// for this OS into a temp bin dir and runs each with --version.
// Network and about 300 MB of disk.
func TestRealDocumentToolsInstall(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "bin")
	svc := New(bin, Catalog(), core.NewRegistry(), core.NopEmitter{})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	for _, c := range []struct {
		spec ArchiveSpec
		exe  string
		want string // first word(s) of --version
	}{
		{PandocArchive(), "pandoc", PandocVersion},
		{TypstArchive(), "typst", "typst " + TypstVersion},
		{MonolithArchive(), "monolith", "monolith " + MonolithVersion},
	} {
		t.Run(c.exe, func(t *testing.T) {
			job := core.NewJobContext(core.JobContext{ID: "smoke", TempDir: t.TempDir()}, core.JobHooks{
				Progress: func(float64, string) {},
				Log:      func(_ core.LogStream, l string) { t.Log(l) },
			})
			if err := svc.InstallManagedArchive(ctx, job, c.spec); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(bin, c.spec.InstallDir)
			ents, _ := os.ReadDir(dir)
			var names []string
			for _, e := range ents {
				names = append(names, e.Name())
			}
			t.Logf("%s contains %v", c.exe, names)
			if len(names) != 2 { // the executable + VERSION
				t.Errorf("unexpected files in %s: %v", c.exe, names)
			}
			name := c.exe
			if svc.goos == "windows" {
				name += ".exe"
			}
			out, err := proc.Output(ctx, 30*time.Second, filepath.Join(dir, name), "--version")
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(firstLine(out), c.want) {
				t.Errorf("--version printed %.80q, want it to contain %q", out, c.want)
			}
			sp, _ := svc.spec(c.spec.DepID)
			if p, src := svc.find(sp); src != core.SourceManaged {
				t.Errorf("not detected as managed: %q %v", p, src)
			}
			if st := svc.detectOne(ctx, sp); st.State != core.DepOK || st.Version != c.spec.Version {
				t.Errorf("detect: %+v", st)
			}
			// Installing again is a no-op.
			if err := svc.InstallManagedArchive(ctx, job, c.spec); err != nil {
				t.Fatal(err)
			}
		})
	}
}
