package pipelines

import (
	"archive/zip"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func TestCleanName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain", "plain"},
		{`a<b>:c/d\e|f?g*h"i`, "a-b--c-d-e-f-g-h-i"},
		{"  two   spaces  ", "two spaces"},
		{"tab\there\nnewline", "tab-here-newline"},
		{"trailing dot.", "trailing dot"},
		{"...", ""},
		{"", ""},
		{strings.Repeat("é", 200), strings.Repeat("é", 150)},
		{"Song · 128 BPM · A minor", "Song · 128 BPM · A minor"},
	}
	for _, c := range cases {
		if got := cleanName(c.in); got != c.want {
			t.Errorf("cleanName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRenameCopiesRunInputs(t *testing.T) {
	h := newHarness(t, nil)
	in := writeFile(t, filepath.Join(t.TempDir(), "in", "song.wav"), "wav")
	rec, err := h.run(Options{Action: ActionRename, Pipeline: "Sampling: 1/2", Rename: []RenameOp{
		{Path: in, Name: "Song · 128 BPM", Role: "bass", RoleLabel: "Bass"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(h.library, "Pipelines", "Sampling- 1-2", "Song · 128 BPM.wav")
	if !exists(want) {
		t.Fatalf("copy missing at %s", want)
	}
	if !exists(in) {
		t.Fatal("the run's input must not be moved")
	}
	files := rec.files(t)
	if len(files) != 1 || files[0].Path != want || files[0].Role != "bass" || files[0].RoleLabel != "Bass" || files[0].OutputID == "" {
		t.Fatalf("result = %+v", files)
	}
	if len(rec.outputs) != 1 {
		t.Fatalf("outputs = %d, want the copy registered", len(rec.outputs))
	}
}

func TestRenameMovesRunMadeFiles(t *testing.T) {
	h := newHarness(t, nil)
	made := writeFile(t, filepath.Join(h.library, "Stems", "vocals.flac"), "f")
	out := h.outputs.add(made)
	rec, err := h.run(Options{Action: ActionRename, Pipeline: "P", Rename: []RenameOp{
		{Path: made, Name: "Song: vocals", Move: true, Role: "vocals", RoleLabel: "Vocals", OutputID: out.ID},
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(h.library, "Stems", "Song- vocals.flac")
	if exists(made) || !exists(want) {
		t.Fatalf("not renamed in place: old=%v new=%v", exists(made), exists(want))
	}
	if len(h.outputs.moved) != 1 || h.outputs.moved[0] != out.ID+" -> "+want {
		t.Fatalf("MoveOutput calls = %v", h.outputs.moved)
	}
	if len(h.events) != 1 || h.events[0] != core.EventLibraryAdded {
		t.Fatalf("events = %v", h.events)
	}
	f := rec.files(t)[0]
	if f.Path != want || f.OutputID != out.ID || f.Role != "vocals" {
		t.Fatalf("result = %+v", f)
	}
	if len(rec.outputs) != 0 {
		t.Fatal("a moved file is not a new output")
	}
}

func TestRenameCollisionsAndEmptyNames(t *testing.T) {
	h := newHarness(t, nil)
	dir := t.TempDir()
	a := writeFile(t, filepath.Join(dir, "a.txt"), "a")
	b := writeFile(t, filepath.Join(dir, "b.txt"), "b")
	c := writeFile(t, filepath.Join(dir, "keep me.txt"), "c")
	rec, err := h.run(Options{Action: ActionRename, Pipeline: "P", Rename: []RenameOp{
		{Path: a, Name: "same"}, {Path: b, Name: "same"}, {Path: c, Name: "///"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(h.library, "Pipelines", "P")
	for _, n := range []string{"same.txt", "same (1).txt", "---.txt"} {
		if !exists(filepath.Join(base, n)) {
			t.Errorf("missing %s", n)
		}
	}
	_ = rec

	// an empty cleaned name keeps the old one
	rec, err = h.run(Options{Action: ActionRename, Pipeline: "Q", Rename: []RenameOp{{Path: c, Name: "..."}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := filepath.Base(rec.files(t)[0].Path); got != "keep me.txt" {
		t.Fatalf("empty name gave %q", got)
	}
}

func TestRenameMoveCollisionAndRollback(t *testing.T) {
	h := newHarness(t, nil)
	dir := filepath.Join(h.library, "X")
	a := writeFile(t, filepath.Join(dir, "a.wav"), "a")
	writeFile(t, filepath.Join(dir, "new.wav"), "taken")
	idA := h.outputs.add(a)
	rec, err := h.run(Options{Action: ActionRename, Pipeline: "P", Rename: []RenameOp{{Path: a, Name: "new", Move: true, OutputID: idA.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := filepath.Base(rec.files(t)[0].Path); got != "new (1).wav" {
		t.Fatalf("collision gave %q", got)
	}
	if readFile(t, filepath.Join(dir, "new.wav")) != "taken" {
		t.Fatal("an existing file was overwritten")
	}

	// an unknown Library record rolls the rename back
	b := writeFile(t, filepath.Join(dir, "b.wav"), "b")
	_, err = h.run(Options{Action: ActionRename, Pipeline: "P", Rename: []RenameOp{{Path: b, Name: "c", Move: true, OutputID: "nope"}}})
	if err == nil {
		t.Fatal("want an error")
	}
	if !exists(b) || exists(filepath.Join(dir, "c.wav")) {
		t.Fatal("the rename was not rolled back")
	}
}

func TestRenameMissingFile(t *testing.T) {
	h := newHarness(t, nil)
	_, err := h.run(Options{Action: ActionRename, Pipeline: "P", Rename: []RenameOp{{Path: filepath.Join(t.TempDir(), "gone.wav"), Name: "x", Move: true}}})
	var ae *core.AppError
	if err == nil || !strings.Contains(err.Error(), "isn't there any more") {
		t.Fatalf("err = %v (%v)", err, ae)
	}
}

func TestCopyNeverOverwrites(t *testing.T) {
	h := newHarness(t, nil)
	src := writeFile(t, filepath.Join(t.TempDir(), "x.wav"), "new")
	dest := filepath.Join(t.TempDir(), "out")
	writeFile(t, filepath.Join(dest, "x.wav"), "old")
	rec, err := h.run(Options{Action: ActionCopy, Pipeline: "P", Copy: &CopyJob{
		Folder: filepath.Join(dest, "sub"), Files: []string{src}, Carry: []CarriedFile{{Role: "r", RoleLabel: "R", OutputID: "o9"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(dest, "sub", "x.wav")); got != "new" {
		t.Fatalf("copy = %q", got)
	}
	// a second run lands beside it
	if _, err := h.run(Options{Action: ActionCopy, Pipeline: "P", Copy: &CopyJob{Folder: filepath.Join(dest, "sub"), Files: []string{src}}}); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(dest, "sub", "x (1).wav")) {
		t.Fatal("second copy did not get a free name")
	}
	// files in the result are the originals
	f := rec.files(t)[0]
	if f.Path != src || f.Role != "r" || f.OutputID != "o9" {
		t.Fatalf("result = %+v", f)
	}
	if len(rec.outputs) != 0 {
		t.Fatal("copies are not Library outputs")
	}
}

func TestValidateCopyFolderRules(t *testing.T) {
	h := newHarness(t, nil)
	ok := t.TempDir()
	cases := []struct {
		name, folder string
		wantErr      string
	}{
		{"empty", "", "Choose a folder"},
		{"relative", "some/folder", "full path"},
		{"library", h.library, "outside your Library"},
		{"inside library", filepath.Join(h.library, "Pipelines", "x"), "outside your Library"},
		{"fine", ok, ""},
		{"not yet existing", filepath.Join(ok, "new"), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw := mustJSON(t, Options{Action: ActionCopy, Copy: &CopyJob{Folder: c.folder, Files: []string{"x"}}})
			err := h.m.Validate(nil, raw)
			switch {
			case c.wantErr == "" && err != nil:
				t.Fatalf("unexpected error %v", err)
			case c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)):
				t.Fatalf("err = %v, want %q", err, c.wantErr)
			}
		})
	}
}

func TestTableCSV(t *testing.T) {
	h := newHarness(t, nil)
	rec, err := h.run(Options{Action: ActionTable, Pipeline: "Receipts", Table: &TableJob{
		Name:   "Receipts 2026-01-02",
		Header: []string{"File", "Merchant", "Note"},
		Rows: [][]string{
			{"a", "Café, Bar", `says "hi"`},
			{"b", "plain", "two\nlines"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	f := rec.files(t)[0]
	if f.Role != "table" || filepath.Base(f.Path) != "Receipts 2026-01-02.csv" || f.OutputID == "" {
		t.Fatalf("result = %+v", f)
	}
	raw := readFile(t, f.Path)
	if !strings.HasPrefix(raw, "\xEF\xBB\xBF") {
		t.Fatal("no UTF-8 BOM")
	}
	want := "File,Merchant,Note\r\na,\"Café, Bar\",\"says \"\"hi\"\"\"\r\nb,plain,\"two\r\nlines\"\r\n"
	if got := strings.TrimPrefix(raw, "\xEF\xBB\xBF"); got != want {
		t.Fatalf("csv =\n%q\nwant\n%q", got, want)
	}
}

func TestValidateTableRows(t *testing.T) {
	h := newHarness(t, nil)
	raw := mustJSON(t, Options{Action: ActionTable, Table: &TableJob{Header: []string{"a", "b"}, Rows: [][]string{{"1"}}}})
	if err := h.m.Validate(nil, raw); err == nil {
		t.Fatal("want a row-length error")
	}
}

func TestZipStoresAndDeflates(t *testing.T) {
	h := newHarness(t, nil)
	dir := t.TempDir()
	txt := writeFile(t, filepath.Join(dir, "a", "notes.txt"), strings.Repeat("hello ", 500))
	txt2 := writeFile(t, filepath.Join(dir, "b", "notes.txt"), "second")
	png := writeFile(t, filepath.Join(dir, "pic.png"), "not really a png")
	mp3 := writeFile(t, filepath.Join(dir, "song.MP3"), "mp3")
	rec, err := h.run(Options{Action: ActionZip, Pipeline: "Before", Zip: &ZipJob{Name: "Before 2026", Files: []string{txt, txt2, png, mp3}}})
	if err != nil {
		t.Fatal(err)
	}
	f := rec.files(t)[0]
	if f.Role != "zip" || filepath.Base(f.Path) != "Before 2026.zip" {
		t.Fatalf("result = %+v", f)
	}
	zr, err := zip.OpenReader(f.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	got := map[string]uint16{}
	var order []string
	for _, e := range zr.File {
		got[e.Name] = e.Method
		order = append(order, e.Name)
	}
	if strings.Join(order, "|") != "notes.txt|notes (2).txt|pic.png|song.MP3" {
		t.Fatalf("entries = %v", order)
	}
	if got["notes.txt"] != zip.Deflate || got["notes (2).txt"] != zip.Deflate || got["pic.png"] != zip.Store || got["song.MP3"] != zip.Store {
		t.Fatalf("methods = %v", got)
	}
	r, _ := zr.File[1].Open()
	b, _ := io.ReadAll(r)
	r.Close()
	if string(b) != "second" {
		t.Fatalf("content = %q", b)
	}
}

func TestZipFailureLeavesNothing(t *testing.T) {
	h := newHarness(t, nil)
	_, err := h.run(Options{Action: ActionZip, Pipeline: "P", Zip: &ZipJob{Name: "z", Files: []string{filepath.Join(t.TempDir(), "missing.txt")}}})
	if err == nil {
		t.Fatal("want an error")
	}
	entries, _ := os.ReadDir(filepath.Join(h.library, "Pipelines", "P"))
	if len(entries) != 0 {
		t.Fatalf("left %d files behind", len(entries))
	}
}

func TestRunHonoursCancel(t *testing.T) {
	h := newHarness(t, nil)
	in := writeFile(t, filepath.Join(t.TempDir(), "a.txt"), "a")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := h.runCtx(ctx, Options{Action: ActionRename, Pipeline: "P", Rename: []RenameOp{{Path: in, Name: "b"}}})
	if err == nil {
		t.Fatal("want a cancellation error")
	}
}

func TestValidateRejectsUnknownAction(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.m.Validate(nil, []byte(`{"action":"explode"}`)); err == nil {
		t.Fatal("want an error")
	}
	if err := h.m.Validate(nil, []byte(`{"action":"zip","bogus":1}`)); err == nil {
		t.Fatal("unknown fields must be rejected")
	}
}
