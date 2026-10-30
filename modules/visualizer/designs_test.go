package visualizer

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDesignStore(t *testing.T) {
	d := &designStore{path: filepath.Join(t.TempDir(), "visualizer", "designs.json")}
	if l, err := d.list(); err != nil || len(l) != 0 {
		t.Fatalf("empty list = %v, %v", l, err)
	}
	a, err := d.put(Design{Name: "  Night  ", ShowJSON: `{"version":1}`})
	if err != nil || a.ID == "" || a.Name != "Night" {
		t.Fatalf("put = %+v, %v", a, err)
	}
	b, err := d.put(Design{Name: "", ShowJSON: `{"version":1,"x":2}`})
	if err != nil || b.Name != "My design" {
		t.Fatalf("put b = %+v, %v", b, err)
	}
	l, _ := d.list()
	if len(l) != 2 || l[0].ID != b.ID {
		t.Fatalf("newest first: %+v", l)
	}
	a.ShowJSON = `{"version":1,"y":3}`
	if _, err := d.put(a); err != nil {
		t.Fatal(err)
	}
	l, _ = d.list()
	if len(l) != 2 || l[0].ID != a.ID || !strings.Contains(l[0].ShowJSON, `"y"`) {
		t.Fatalf("update moves to the top: %+v", l)
	}
	if err := d.rename(b.ID, strings.Repeat("x", 200)); err != nil {
		t.Fatal(err)
	}
	if err := d.rename("nope", "z"); err == nil {
		t.Error("renaming a missing design should fail")
	}
	if err := d.remove(a.ID); err != nil {
		t.Fatal(err)
	}
	l, _ = d.list()
	if len(l) != 1 || len([]rune(l[0].Name)) != maxNameRunes {
		t.Fatalf("after remove: %+v", l)
	}
	for _, bad := range []string{"", "{", strings.Repeat("a", 600<<10)} {
		if _, err := d.put(Design{ShowJSON: bad}); err == nil {
			t.Errorf("put(%.10q) should fail", bad)
		}
	}
}

func TestDesignStoreLimit(t *testing.T) {
	d := &designStore{path: filepath.Join(t.TempDir(), "designs.json")}
	for i := 0; i < maxDesigns; i++ {
		if _, err := d.put(Design{ShowJSON: `{}`}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := d.put(Design{ShowJSON: `{}`}); err == nil {
		t.Error("the 51st design should be refused")
	}
}
