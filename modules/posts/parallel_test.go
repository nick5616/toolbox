package posts

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestSlideInfoKeepsOrderInParallel(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	var paths []string
	for i := 0; i < 20; i++ {
		p := filepath.Join(dir, fmt.Sprintf("p%02d.png", i))
		writePNG(t, p, gradient(10+i, 8))
		paths = append(paths, p)
	}
	paths = append(paths, filepath.Join(dir, "gone.jpg"))
	got, err := NewService(nil, e.m).SlideInfo(paths)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(paths) {
		t.Fatalf("got %d rows", len(got))
	}
	for i, g := range got {
		if g.Path != paths[i] {
			t.Fatalf("row %d is %s", i, g.Path)
		}
		if i < 20 && g.Width != 10+i {
			t.Errorf("row %d width %d", i, g.Width)
		}
	}
	if got[20].Error == "" {
		t.Error("missing file has no error")
	}
}
