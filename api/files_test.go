package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/store"
)

func newFiles(t *testing.T) (*FilesService, string, string) {
	t.Helper()
	root := t.TempDir()
	lib, support := filepath.Join(root, "lib"), filepath.Join(root, "support")
	db, err := store.Open(filepath.Join(support, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	settings, err := core.NewSettingsService(db, nil, lib)
	if err != nil {
		t.Fatal(err)
	}
	return &FilesService{Reg: core.NewRegistry(), Settings: settings, Paths: core.NewPaths(support)}, lib, root
}

func write(t *testing.T, path string, b []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadText(t *testing.T) {
	fs, lib, root := newFiles(t)
	p := write(t, filepath.Join(lib, "Transcripts", "a.txt"), []byte("héllo world"))
	if got, err := fs.ReadText(p, 0); err != nil || got != "héllo world" {
		t.Fatalf("full: %q %v", got, err)
	}
	// "h" + first byte of "é" — the split rune is dropped.
	if got, err := fs.ReadText(p, 2); err != nil || got != "h" {
		t.Fatalf("split: %q %v", got, err)
	}
	outside := write(t, filepath.Join(root, "elsewhere.txt"), []byte("x"))
	if _, err := fs.ReadText(outside, 0); !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("outside: %v", err)
	}
	if _, err := fs.ReadText(filepath.Join(lib, "missing.txt"), 0); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("missing: %v", err)
	}
	big := write(t, filepath.Join(lib, "big.txt"), []byte(strings.Repeat("a", MaxReadTextBytes+10)))
	if got, _ := fs.ReadText(big, 1<<30); len(got) != MaxReadTextBytes {
		t.Fatalf("cap: %d", len(got))
	}
}

func TestImageDataURL(t *testing.T) {
	fs, _, root := newFiles(t)
	png := write(t, filepath.Join(root, "x.PNG"), []byte{0x89, 'P', 'N', 'G'})
	got, err := fs.ImageDataURL(png)
	if err != nil || got != "data:image/png;base64,iVBORw==" {
		t.Fatalf("png: %q %v", got, err)
	}
	txt := write(t, filepath.Join(root, "x.txt"), []byte("secret"))
	if _, err := fs.ImageDataURL(txt); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("non-image read: %v", err)
	}
	if _, err := fs.ImageDataURL(filepath.Join(root, "nope.jpg")); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("missing: %v", err)
	}
}
