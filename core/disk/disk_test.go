package disk

import (
	"path/filepath"
	"testing"
)

func TestFreeExistingAndMissingChild(t *testing.T) {
	dir := t.TempDir()
	free, total, err := Free(dir)
	if err != nil {
		t.Fatal(err)
	}
	if total == 0 || free > total {
		t.Fatalf("free %d total %d", free, total)
	}
	child := filepath.Join(dir, "not", "yet", "created")
	_, t2, err := Free(child)
	if err != nil {
		t.Fatal(err)
	}
	if t2 != total {
		t.Errorf("child total %d, parent total %d", t2, total)
	}
	if _, _, err := Free(""); err == nil {
		t.Error("empty path should fail")
	}
}
