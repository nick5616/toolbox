package api

import (
	"path/filepath"
	"testing"
)

// recSearch records what Smart search was told.
type recSearch struct {
	renamed [][2]string
	removed []string
}

func (r *recSearch) Renamed(from, to string) { r.renamed = append(r.renamed, [2]string{from, to}) }
func (r *recSearch) Removed(paths ...string) { r.removed = append(r.removed, paths...) }

// Smart search's index follows Library renames and trashed files.
func TestLibraryTellsSearchAboutRenameAndTrash(t *testing.T) {
	e := newLibEnv(t)
	rec := &recSearch{}
	e.svc.Search = rec
	a := e.reg(t, "F/a.png", "m", 1)
	b := e.reg(t, "F/b.png", "m", 2)

	o, err := e.svc.Rename(a.ID, "fresh")
	if err != nil {
		t.Fatal(err)
	}
	if len(rec.renamed) != 1 || rec.renamed[0][0] != a.Path || rec.renamed[0][1] != o.Path || filepath.Base(o.Path) != "fresh.png" {
		t.Fatalf("renamed = %v", rec.renamed)
	}
	// a refused rename tells nobody
	if _, err := e.svc.Rename(a.ID, "NUL"); err == nil {
		t.Fatal("reserved name accepted")
	}
	if len(rec.renamed) != 1 {
		t.Fatalf("refused rename was reported: %v", rec.renamed)
	}

	e.fake.Fail = map[string]error{b.Path: errTrash}
	res, err := e.svc.Trash([]string{o.ID, b.ID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Trashed) != 1 || len(rec.removed) != 1 || rec.removed[0] != o.Path {
		t.Fatalf("removed = %v (trashed %v)", rec.removed, res.Trashed)
	}
}

type trashErr string

func (e trashErr) Error() string { return string(e) }

const errTrash = trashErr("in use")
