package mediaindex

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"toolbox/core"
)

func TestKindOf(t *testing.T) {
	cases := map[string]string{
		"a.JPG": "image", "a.heic": "image", "a.gif": "image", "a.tiff": "image",
		"a.mp4": "video", "a.MKV": "video", "a.m4v": "video",
		"a.mp3": "audio", "a.opus": "audio", "a.aac": "audio",
		"a.pdf": "pdf", "a.docx": "doc", "a.md": "doc", "a.srt": "doc", "a.epub": "doc",
		"a.zip": "", "a.exe": "", "noext": "", "a.aiff": "",
	}
	for name, want := range cases {
		got, ok := KindOf(name)
		if got != want || ok != (want != "") {
			t.Errorf("%s: got %q,%v want %q", name, got, ok, want)
		}
	}
}

func TestScanRulesSkips(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Toolbox")
	other := filepath.Join(root, "app-data") // a support dir inside the library
	// An excluded folder that contains the library itself is ignored.
	r := newScanRules(root, []string{"Received", `Old\Stuff`, "/Trailing/", " "}, []string{other, filepath.Dir(root)})
	if len(r.exclude) != 1 {
		t.Fatalf("exclude: %v", r.exclude)
	}
	dirs := map[string]bool{
		"": false, "Photos": false, "Received": true, "received": true, "Received/Phone": true,
		"Receivedx": false, "Old/Stuff": true, "Old": false, "Old/Stuff/x/y": true, "Trailing/a": true,
		"app-data": true, "app-data/clipboard": true, "app-data2": false,
	}
	for rel, want := range dirs {
		if got := r.skipDir(rel); got != want {
			t.Errorf("skipDir(%q) = %v want %v", rel, got, want)
		}
	}
	files := map[string]bool{
		"a.jpg": false, "Photos/a.jpg": false, ".hidden.jpg": true, "Photos/.thumbs/a.jpg": true,
		"Received/a.jpg": true, "Thumbs.db": true, "app-data/x.png": true, "Photos/desktop.ini": true,
	}
	for rel, want := range files {
		if got := r.skipPath(filepath.Join(root, filepath.FromSlash(rel))); got != want {
			t.Errorf("skipPath(%q) = %v want %v", rel, got, want)
		}
	}
	if !r.skipPath(filepath.Join(filepath.Dir(root), "outside.jpg")) {
		t.Error("a path outside the library is skipped")
	}
	if !r.skipPath(root) {
		t.Error("the root itself is no file")
	}
}

func touch(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func relList(root string, cs []candidate) []string {
	var out []string
	for _, c := range cs {
		r, _ := filepath.Rel(root, c.path)
		out = append(out, filepath.ToSlash(r))
	}
	sort.Strings(out)
	return out
}

func TestWalkLibrary(t *testing.T) {
	root := t.TempDir()
	for _, f := range []string{
		"a.jpg", "b.mp4", "c.mp3", "d.pdf", "e.docx", "notes.txt", "ignored.zip", "noext",
		"sub/deep/f.png", ".hidden/g.jpg", ".dot.jpg", "Received/h.jpg", "support/clipboard/i.png",
		"Vault/j.jpg", "Thumbs.db",
	} {
		touch(t, filepath.Join(root, filepath.FromSlash(f)), 3)
	}
	// a symlinked folder and file are never followed
	outside := t.TempDir()
	touch(t, filepath.Join(outside, "secret.jpg"), 3)
	if err := os.Symlink(outside, filepath.Join(root, "linkdir")); err != nil {
		t.Logf("symlinks unavailable (%v); skipping that part", err)
	} else {
		_ = os.Symlink(filepath.Join(outside, "secret.jpg"), filepath.Join(root, "linkfile.jpg"))
	}
	r := newScanRules(root, []string{"Received"}, []string{filepath.Join(root, "support"), filepath.Join(root, "Vault")})
	cs, err := r.walk(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := relList(root, cs)
	want := []string{"a.jpg", "b.mp4", "c.mp3", "d.pdf", "e.docx", "notes.txt", "sub/deep/f.png"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("walk:\n got %v\nwant %v", got, want)
	}
	kinds := map[string]string{}
	for _, c := range cs {
		kinds[filepath.Base(c.path)] = c.kind
	}
	if kinds["b.mp4"] != "video" || kinds["notes.txt"] != "doc" || kinds["c.mp3"] != "audio" {
		t.Fatalf("kinds: %v", kinds)
	}
	if _, err := newScanRules(filepath.Join(root, "missing"), nil, nil).walk(context.Background()); err == nil {
		t.Fatal("a missing library is an error (so nothing is deleted)")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.walk(ctx); err == nil {
		t.Fatal("a cancelled walk should stop")
	}
}

func TestBuildItemLimitsAndStages(t *testing.T) {
	const mb = 1 << 20
	cases := []struct {
		name         string
		kind         string
		size         int64
		speech       bool
		state, speed string
		reason       string
	}{
		{"image", "image", 5 * mb, true, "pending", "none", ""},
		{"image too big", "image", 201 * mb, true, "skipped", "none", "Larger than 200 MB"},
		{"pdf too big", "pdf", 300 * mb, false, "skipped", "none", "Larger than 200 MB"},
		{"doc ok", "doc", 200 * mb, false, "pending", "none", ""},
		{"video", "video", 3000 * mb, true, "pending", "pending", ""},
		{"video speech off", "video", 3000 * mb, false, "pending", "none", ""},
		{"video 5GB", "video", 5 << 30, true, "skipped", "none", "Larger than 4 GB"},
		{"audio", "audio", 10 * mb, true, "done", "pending", ""},
		{"audio speech off", "audio", 10 * mb, false, "done", "none", ""},
		{"audio 5GB", "audio", 5 << 30, true, "skipped", "none", "Larger than 4 GB"},
	}
	for _, c := range cases {
		it := buildItem("/x/"+c.name, c.kind, core.SearchSourceLibrary, "", c.size, 7, c.speech)
		if it.State != c.state || it.SpeechState != c.speed || it.Reason != c.reason {
			t.Errorf("%s: %+v", c.name, it)
		}
	}
}

func TestDiffItems(t *testing.T) {
	mk := func(p string, size, mod int64) Item {
		return Item{Path: p, Size: size, ModMs: mod, State: StatePending}
	}
	existing := []Item{mk("/l/same.jpg", 1, 1), mk("/l/changed.jpg", 1, 1), mk("/l/gone.jpg", 1, 1)}
	desired := []Item{mk("/l/same.jpg", 1, 1), mk("/l/changed.jpg", 2, 1), mk("/l/new.jpg", 3, 3)}
	add, changed, remove := diffItems(existing, desired)
	if len(add) != 1 || add[0].Path != "/l/new.jpg" || len(changed) != 1 || changed[0].Path != "/l/changed.jpg" ||
		len(remove) != 1 || remove[0] != "/l/gone.jpg" {
		t.Fatalf("diff: %v %v %v", add, changed, remove)
	}
	// a touched mod time alone also counts as changed
	_, ch, _ := diffItems(existing[:1], []Item{mk("/l/same.jpg", 1, 9)})
	if len(ch) != 1 {
		t.Fatal("mod time change missed")
	}
}

func TestCleanSkip(t *testing.T) {
	good := map[string]string{"Received": "Received", `a\b`: "a/b", " a//b/ ": "a/b", "./x": "x", "": ""}
	for in, want := range good {
		if got, err := cleanSkip(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"..", "a/../..", "/abs", `C:\x`, "c:/x", `\\server\share`} {
		if _, err := cleanSkip(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}
