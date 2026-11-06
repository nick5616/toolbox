package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

type fakeClip struct {
	files []string
	img   []byte
}

func (f fakeClip) Files(context.Context) ([]string, error) { return f.files, nil }
func (f fakeClip) Image(context.Context) ([]byte, error)   { return f.img, nil }

func TestClipboardFiles(t *testing.T) {
	s, _, root := newFiles(t)
	real := write(t, filepath.Join(root, "a.txt"), []byte("x"))
	got, err := s.clipboardFiles(context.Background(), fakeClip{files: []string{real, filepath.Join(root, "gone.txt"), "rel.txt"}, img: []byte("png")})
	if err != nil || len(got) != 1 || got[0] != real {
		t.Fatalf("files: %v %v", got, err)
	}

	got, err = s.clipboardFiles(context.Background(), fakeClip{img: []byte("pngdata")})
	if err != nil || len(got) != 1 || !core.IsWithin(got[0], s.Paths.TmpDir) || !strings.HasSuffix(got[0], ".png") {
		t.Fatalf("image: %v %v", got, err)
	}
	if b, _ := os.ReadFile(got[0]); string(b) != "pngdata" {
		t.Fatalf("image bytes: %q", b)
	}

	got, err = s.clipboardFiles(context.Background(), fakeClip{})
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
}
