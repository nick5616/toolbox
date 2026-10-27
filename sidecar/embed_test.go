package sidecarfiles

import (
	"slices"
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
