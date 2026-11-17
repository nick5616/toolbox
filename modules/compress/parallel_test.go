package compress

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestEstimateKeepsOrderInParallel(t *testing.T) {
	dir := t.TempDir()
	var paths []string
	for i := 0; i < 30; i++ {
		ext := []string{".txt", ".png", ".bin"}[i%3]
		p := filepath.Join(dir, fmt.Sprintf("f%02d%s", i, ext))
		paths = append(paths, p)
		if i%5 == 4 {
			continue // left missing
		}
		if err := os.WriteFile(p, []byte("small"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := (&Service{mod: &Module{}}).Estimate(paths, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(paths) {
		t.Fatalf("got %d rows", len(got))
	}
	for i, e := range got {
		if e.Path != paths[i] {
			t.Fatalf("row %d is %s", i, e.Path)
		}
		if (i%5 == 4) != (e.Problem == "File not found") {
			t.Errorf("row %d problem %q", i, e.Problem)
		}
	}
}
