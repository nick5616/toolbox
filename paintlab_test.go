package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestPaintLabSink(t *testing.T) {
	t.Setenv("TOOLBOX_PAINTLAB", "1")
	dir := t.TempDir()
	s := newPaintLabSink(dir, []string{"http://wails.localhost"})
	if s == nil {
		t.Fatal("sink should exist with TOOLBOX_PAINTLAB=1")
	}
	b64 := base64.StdEncoding.EncodeToString([]byte("png"))
	cases := []struct {
		name, msg, origin string
		handled, written  bool
		file              string
	}{
		{"ok", "plab|hash.json|" + b64, "http://wails.localhost", true, true, "hash.json"},
		{"other prefix", "vz1|x", "http://wails.localhost", false, false, ""},
		{"foreign origin", "plab|a.png|" + b64, "http://evil.example", true, false, "a.png"},
		{"traversal", "plab|../x.png|" + b64, "http://wails.localhost", true, false, "../x.png"},
		{"slash", "plab|a/b.png|" + b64, "http://wails.localhost", true, false, "a/b.png"},
		{"bad base64", "plab|c.png|***", "http://wails.localhost", true, false, "c.png"},
	}
	for _, c := range cases {
		if got := s.handle(c.msg, c.origin); got != c.handled {
			t.Errorf("%s: handled = %v, want %v", c.name, got, c.handled)
		}
		if c.file == "" {
			continue
		}
		_, err := os.Stat(filepath.Join(dir, c.file))
		if (err == nil) != c.written {
			t.Errorf("%s: written = %v, want %v", c.name, err == nil, c.written)
		}
	}
}

func TestPaintLabOffByDefault(t *testing.T) {
	t.Setenv("TOOLBOX_PAINTLAB", "")
	if newPaintLabSink(t.TempDir(), nil) != nil {
		t.Fatal("sink must be nil without TOOLBOX_PAINTLAB=1")
	}
	var s *paintLabSink
	if s.handle("plab|x|y", "o") {
		t.Fatal("a nil sink handles nothing")
	}
	if paintLabURL() != "" {
		t.Fatal("no URL without the env")
	}
}

func TestPaintLabURL(t *testing.T) {
	t.Setenv("TOOLBOX_PAINTLAB", "1")
	t.Setenv("TOOLBOX_VIEW", "paintlab")
	t.Setenv("TOOLBOX_PAINTLAB_ONLY", "soft round")
	t.Setenv("TOOLBOX_PAINTLAB_MODE", "fps")
	if got, want := paintLabURL(), "/?window=paintlab&only=soft%20round&mode=fps"; got != want {
		t.Fatalf("url = %q, want %q", got, want)
	}
}
