package sidecarfiles

import (
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestEmbeddedFiles(t *testing.T) {
	files := Files()
	for _, want := range []string{"pyproject.toml", "uv.lock", ".python-version", "toolbox_sidecar/__init__.py", "toolbox_sidecar/__main__.py", "toolbox_sidecar/protocol.py", "toolbox_sidecar/handlers/__init__.py"} {
		if !slices.Contains(files, want) {
			t.Errorf("missing %s in %v", want, files)
		}
	}
	for _, f := range files {
		if slices.Contains([]string{"__pycache__"}, f) {
			t.Errorf("unexpected %s", f)
		}
	}
	if len(Hash()) != 64 || Hash() != Hash() {
		t.Fatalf("hash = %q", Hash())
	}
}

// Every .py file of the engine on disk must be embedded: a new subpackage
// missing from the go:embed globs breaks every fresh engine install.
func TestEveryPythonFileEmbedded(t *testing.T) {
	files := Files()
	err := filepath.WalkDir("toolbox_sidecar", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == "__pycache__" {
			return filepath.SkipDir
		}
		if !d.IsDir() && strings.HasSuffix(p, ".py") && !slices.Contains(files, filepath.ToSlash(p)) {
			t.Errorf("%s is not embedded; add its folder to the go:embed line in embed.go", filepath.ToSlash(p))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
