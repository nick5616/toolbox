//go:build windows

package trash

import (
	"os"
	"path/filepath"
	"testing"
)

// TOOLBOX_TRASH_E2E=1 sends one file this test created to the real Recycle Bin.
func TestWindowsRecycleBin(t *testing.T) {
	if os.Getenv("TOOLBOX_TRASH_E2E") != "1" {
		t.Skip("set TOOLBOX_TRASH_E2E=1 to use the real Recycle Bin")
	}
	p := filepath.Join(t.TempDir(), "toolbox-trash-test.txt")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	errs := Default().Trash([]string{p, filepath.Join(t.TempDir(), "missing.txt")})
	if errs[0] != nil {
		t.Fatalf("trash: %v", errs[0])
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("file still there: %v", err)
	}
	if errs[1] == nil {
		t.Log("missing file reported no error (shell returns success for some missing paths)")
	}
}
