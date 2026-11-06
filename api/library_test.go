package api

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"toolbox/core"
	"toolbox/core/store"
	"toolbox/core/trash"
)

type libEnv struct {
	svc     *LibraryService
	db      *store.DB
	lib     string
	support string
	fake    *trash.Fake
	events  []string
}

type recEm struct{ env *libEnv }

func (r recEm) Emit(name string, data any) { r.env.events = append(r.env.events, name) }

func newLibEnv(t *testing.T) *libEnv {
	t.Helper()
	root := t.TempDir()
	e := &libEnv{lib: filepath.Join(root, "lib"), support: filepath.Join(root, "support"), fake: &trash.Fake{}}
	if err := os.MkdirAll(e.lib, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(filepath.Join(e.support, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e.db = db
	settings, err := core.NewSettingsService(db, nil, e.lib)
	if err != nil {
		t.Fatal(err)
	}
	e.svc = &LibraryService{
		Outputs: db, Settings: settings, Paths: core.NewPaths(e.support), Em: recEm{e},
		Lineage: db, JobStore: db, Projects: db, Reg: core.NewRegistry(), Trasher: e.fake,
	}
	return e
}

// reg writes a file and registers it as an output.
func (e *libEnv) reg(t *testing.T, rel, module string, created int64) core.Output {
	t.Helper()
	p := filepath.Join(e.lib, filepath.FromSlash(rel))
	write(t, p, []byte("data-"+rel))
	o, err := e.db.UpsertOutput(context.Background(), core.Output{
		ID: core.NewID(), ModuleID: module, Path: p, Name: filepath.Base(p),
		Kind: core.KindForPath(p), SizeBytes: int64(len("data-" + rel)), CreatedAt: created, Tags: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return o
}

// link makes a directory link (symlink, or a junction on Windows).
func link(t *testing.T, target, name string) {
	t.Helper()
	if err := os.Symlink(target, name); err == nil {
		return
	}
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", name, target).CombinedOutput(); err == nil {
			return
		} else {
			t.Skipf("can't create a link here: %v %s", err, out)
		}
	}
	t.Skip("can't create a symlink here")
}

func TestLibraryQuery(t *testing.T) {
	e := newLibEnv(t)
	e.reg(t, "Images/a.png", "x", 10)
	e.reg(t, "Images/b.png", "y", 20)
	e.reg(t, "Audio/c.mp3", "x", 30)
	p, err := e.svc.Query(core.LibraryQuery{ModuleID: "x"})
	if err != nil || len(p.Items) != 2 || p.Items[0].Name != "c.mp3" {
		t.Fatalf("%+v %v", p, err)
	}
	p, err = e.svc.Query(core.LibraryQuery{Folder: "Images", Sort: core.SortName, Limit: 1})
	if err != nil || len(p.Items) != 1 || p.Items[0].Name != "a.png" || p.NextCursor == "" {
		t.Fatalf("%+v %v", p, err)
	}
	p, err = e.svc.Query(core.LibraryQuery{Folder: "Images", Sort: core.SortName, Limit: 1, Cursor: p.NextCursor})
	if err != nil || len(p.Items) != 1 || p.Items[0].Name != "b.png" || p.NextCursor != "" {
		t.Fatalf("%+v %v", p, err)
	}
	if p, _ := e.svc.Query(core.LibraryQuery{Folder: "Nope"}); p.Items == nil || len(p.Items) != 0 {
		t.Fatalf("empty must be non-nil: %#v", p.Items)
	}
}

func TestLibraryFolders(t *testing.T) {
	e := newLibEnv(t)
	e.reg(t, "Images/a.png", "img", 10)
	write(t, filepath.Join(e.lib, "Images", "loose.txt"), []byte("x"))
	write(t, filepath.Join(e.lib, "Images", "Deep", "z.png"), []byte("x"))
	write(t, filepath.Join(e.lib, ".hidden", "h.png"), []byte("x"))
	write(t, filepath.Join(e.lib, "root.txt"), []byte("x"))
	outside := filepath.Join(t.TempDir(), "outside")
	write(t, filepath.Join(outside, "secret.png"), []byte("x"))
	link(t, outside, filepath.Join(e.lib, "Linked"))
	if err := e.svc.Reg.RegisterPlaceholder(core.Descriptor{ID: "img", Name: "Img", OutputSubdir: "Images", Category: core.CategoryMedia}); err != nil {
		t.Fatal(err)
	}

	root, err := e.svc.Folders()
	if err != nil {
		t.Fatal(err)
	}
	if root.Files != 1 || root.Rel != "" {
		t.Fatalf("root = %+v", root)
	}
	names := map[string]core.LibraryFolder{}
	for _, c := range root.Children {
		names[c.Name] = c
	}
	if _, ok := names["Linked"]; ok {
		t.Fatal("followed a link")
	}
	if _, ok := names[".hidden"]; ok {
		t.Fatal("listed a hidden folder")
	}
	img, ok := names["Images"]
	if !ok || img.Files != 2 || img.Registered != 1 || img.Rel != "Images" || len(img.ModuleIDs) != 1 || img.ModuleIDs[0] != "img" || img.NewestMod == 0 {
		t.Fatalf("Images = %+v", img)
	}
	if len(img.Children) != 1 || img.Children[0].Rel != "Images/Deep" || img.Children[0].Files != 1 {
		t.Fatalf("children = %+v", img.Children)
	}
}

func TestLibraryListDir(t *testing.T) {
	e := newLibEnv(t)
	o := e.reg(t, "Images/a.png", "img", 10)
	write(t, filepath.Join(e.lib, "Images", "b.txt"), []byte("hello"))
	write(t, filepath.Join(e.lib, "Images", "Sub", "c.png"), []byte("x"))
	outside := filepath.Join(t.TempDir(), "outside")
	write(t, filepath.Join(outside, "secret.png"), []byte("x"))
	link(t, outside, filepath.Join(e.lib, "Linked"))

	l, err := e.svc.ListDir("Images", 0)
	if err != nil || len(l.Entries) != 3 || l.Truncated {
		t.Fatalf("%+v %v", l, err)
	}
	if !l.Entries[0].IsDir || l.Entries[0].Name != "Sub" || l.Entries[0].Rel != "Images/Sub" {
		t.Fatalf("dirs first: %+v", l.Entries)
	}
	byName := map[string]core.LibraryEntry{}
	for _, en := range l.Entries {
		byName[en.Name] = en
	}
	if a := byName["a.png"]; a.Output == nil || a.Output.ID != o.ID || a.Kind != core.KindImage || a.SizeBytes == 0 {
		t.Fatalf("a = %+v", a)
	}
	if b := byName["b.txt"]; b.Output != nil || b.Kind != core.KindDocument {
		t.Fatalf("b = %+v", b)
	}
	if l, _ := e.svc.ListDir("Images", 2); len(l.Entries) != 2 || !l.Truncated {
		t.Fatalf("limit: %+v", l)
	}
	if root, err := e.svc.ListDir("", 10); err != nil {
		t.Fatal(err)
	} else {
		for _, en := range root.Entries {
			if en.Name == "Linked" {
				t.Fatal("listed a link")
			}
		}
	}
	abs := e.lib
	for _, bad := range []string{"..", "../x", "Images/../../x", abs, `..\x`, "/etc", `C:\Windows`, "Linked", "Linked/sub"} {
		if _, err := e.svc.ListDir(bad, 10); err == nil {
			t.Errorf("ListDir(%q) accepted", bad)
		}
	}
	if _, err := e.svc.ListDir("Missing", 10); err == nil {
		t.Error("missing folder accepted")
	}
}

// seriesEnv builds a 5-step "erased" series a0 -> a1 -> ... -> a4 by one tool.
func seriesEnv(t *testing.T) (*libEnv, []core.Output) {
	e := newLibEnv(t)
	src := e.reg(t, "Source/photo.png", "other", 1)
	prev := src.Path
	outs := []core.Output{}
	for i := 0; i < 5; i++ {
		o := e.reg(t, fmt.Sprintf("Erased/photo-%d.png", i), "eraser", int64(10+i))
		if err := e.db.AddOutputInputs(context.Background(), o.ID, []string{prev}); err != nil {
			t.Fatal(err)
		}
		prev = o.Path
		outs = append(outs, o)
	}
	return e, outs
}

func TestLibraryDetailChain(t *testing.T) {
	e, outs := seriesEnv(t)
	for i, o := range outs {
		d, err := e.svc.Detail(o.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(d.Chain) != 5 || d.ChainAt != i || d.Chain[i].ID != o.ID || d.Chain[0].ID != outs[0].ID || d.Chain[4].ID != outs[4].ID {
			t.Fatalf("step %d: chainAt %d, len %d", i, d.ChainAt, len(d.Chain))
		}
		if d.Unknown || len(d.MadeFrom) != 1 {
			t.Fatalf("step %d: %+v", i, d)
		}
	}
	d, _ := e.svc.Detail(outs[2].ID)
	if len(d.MadeInto) != 1 || d.MadeInto[0].ID != outs[3].ID {
		t.Fatalf("madeInto = %+v", d.MadeInto)
	}
	// The source (other tool, not registered with lineage) has none.
	d, err := e.svc.Detail(filepath.Join(e.lib, "Source", "photo.png"))
	if err != nil || len(d.Chain) != 0 || !d.Unknown || len(d.MadeInto) != 1 {
		t.Fatalf("source: %+v %v", d, err)
	}
	// Unregistered files are described from disk.
	p := filepath.Join(e.lib, "Loose", "x.txt")
	write(t, p, []byte("abc"))
	d, err = e.svc.Detail(p)
	if err != nil || d.Output.ID != "" || d.Output.SizeBytes != 3 || !d.Unknown || d.Chain == nil {
		t.Fatalf("loose: %+v %v", d, err)
	}
	if _, err := e.svc.Detail(filepath.Join(t.TempDir(), "outside.txt")); err == nil {
		t.Error("outside path accepted")
	}
	if _, err := e.svc.Detail(filepath.Join(e.support, "x")); err == nil {
		t.Error("support path accepted")
	}
	if _, err := e.svc.Detail("nope"); err == nil {
		t.Error("unknown id accepted")
	}
}

func TestLibraryDetailChainCap(t *testing.T) {
	e := newLibEnv(t)
	prev := e.reg(t, "A/f0.png", "m", 1)
	for i := 1; i < 230; i++ {
		o := e.reg(t, fmt.Sprintf("A/f%d.png", i), "m", int64(i+1))
		if err := e.db.AddOutputInputs(context.Background(), o.ID, []string{prev.Path}); err != nil {
			t.Fatal(err)
		}
		prev = o
	}
	d, err := e.svc.Detail(prev.ID)
	if err != nil || len(d.Chain) != maxChain || d.Chain[d.ChainAt].ID != prev.ID {
		t.Fatalf("len %d at %d err %v", len(d.Chain), d.ChainAt, err)
	}
}

func TestLibraryDetailJobAndImage(t *testing.T) {
	e := newLibEnv(t)
	ctx := context.Background()
	job := core.Job{ID: "j1", ModuleID: "m", Title: "Make it", Status: core.JobDone, Inputs: []string{}, OptionsJSON: `{"a":1}`, Attempt: 1, CreatedAt: 1}
	if err := e.db.InsertJob(ctx, job); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(e.lib, "i.png")
	f, _ := os.Create(p)
	png.Encode(f, image.NewRGBA(image.Rect(0, 0, 7, 5)))
	f.Close()
	o, err := e.db.UpsertOutput(ctx, core.Output{ID: core.NewID(), JobID: "j1", ModuleID: "m", Path: p, Name: "i.png", Kind: core.KindImage, SizeBytes: 1, CreatedAt: 2, Tags: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	d, err := e.svc.Detail(o.ID)
	if err != nil || d.JobTitle != "Make it" || d.Options != `{"a":1}` || d.Width != 7 || d.Height != 5 {
		t.Fatalf("%+v %v", d, err)
	}
}

type fakeProjects struct {
	byKind map[core.ProjectKind][]core.StoredProject
}

func (f fakeProjects) ListProjects(_ context.Context, k core.ProjectKind) ([]core.StoredProject, error) {
	return f.byKind[k], nil
}
func (fakeProjects) GetProject(context.Context, string) (core.StoredProject, error) {
	return core.StoredProject{}, errors.New("unused")
}
func (fakeProjects) PutProject(context.Context, core.StoredProject) error { return nil }
func (fakeProjects) DeleteProject(context.Context, string) error          { return nil }

func TestLibraryPlaces(t *testing.T) {
	e := newLibEnv(t)
	mk := func(id string, k core.ProjectKind, data string, at int64) core.StoredProject {
		return core.StoredProject{ID: id, Kind: k, Name: "n" + id, Data: data, UpdatedAt: at}
	}
	e.svc.Projects = fakeProjects{map[core.ProjectKind][]core.StoredProject{
		core.ProjectPost:        {mk("p1", core.ProjectPost, "{}", 1)},
		core.ProjectComposition: {mk("c1", core.ProjectComposition, "{}", 2)},
		core.ProjectVideo:       {mk("v1", core.ProjectVideo, "{}", 3)},
		core.ProjectEdit: {
			mk("e1", core.ProjectEdit, `{"song":{},"analysisKey":"k"}`, 4),
			mk("e2", core.ProjectEdit, `{"song":{}}`, 5),
			mk("e3", core.ProjectEdit, `{}`, 6),
			mk("e4", core.ProjectEdit, `not json`, 7),
		},
		core.ProjectPaint: {mk("pa", core.ProjectPaint, "{}", 8)},
	}}
	write(t, filepath.Join(e.support, "projects", "pa", "thumb.jpg"), []byte("x"))
	write(t, filepath.Join(e.support, "projects", "pa", "render.png"), []byte("x"))
	e.svc.SavedMasks = func() ([]core.LibrarySavedMask, error) {
		return []core.LibrarySavedMask{{ID: "m1", Name: "Mask", Width: 3, Height: 4}}, nil
	}
	pl, err := e.svc.Places()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"p1": "post-builder", "c1": "photo-composer", "v1": "video-editor", "e1": "edit-studio",
		"e2": "video-studio", "e3": "video-studio", "e4": "video-studio", "pa": "paint"}
	if len(pl.Projects) != len(want) {
		t.Fatalf("projects = %d", len(pl.Projects))
	}
	for _, p := range pl.Projects {
		if want[p.ID] != p.ModuleID {
			t.Errorf("%s -> %q, want %q", p.ID, p.ModuleID, want[p.ID])
		}
		if p.ID == "pa" && (p.Thumb == "" || p.Render == "") {
			t.Errorf("paint thumb/render missing: %+v", p)
		}
		if p.ID == "p1" && (p.Thumb != "" || p.Render != "") {
			t.Errorf("post should have none: %+v", p)
		}
	}
	if pl.Projects[0].ID != "pa" {
		t.Errorf("not newest first: %s", pl.Projects[0].ID)
	}
	if len(pl.SavedMasks) != 1 || pl.SavedMasks[0].ID != "m1" {
		t.Fatalf("masks = %+v", pl.SavedMasks)
	}
	e.svc.SavedMasks = nil
	if pl, _ := e.svc.Places(); pl.SavedMasks == nil {
		t.Error("SavedMasks must be non-nil")
	}
}

func TestSanitizeRename(t *testing.T) {
	tests := []struct {
		in, old, want string
		bad           bool
	}{
		{"new", "a.png", "new.png", false},
		{"new.jpg", "a.png", "new.jpg", false},
		{"my cool photo", "a.png", "my cool photo.png", false},
		{"v1.2", "a.png", "v1.2.png", false},
		{"a/b\\c", "x.png", "a_b_c.png", false},
		{"  spaced. ", "x.png", "spaced.png", false},
		{"..", "x.png", "", true},
		{"", "x.png", "", true},
		{"///", "x.png", "", true},
		{"CON", "x.png", "", true},
		{"con.txt", "x.png", "", true},
		{"Lpt3", "x.png", "", true},
		{"com9.png", "x.png", "", true},
		{"console", "x.png", "console.png", false},
	}
	for _, tc := range tests {
		got, err := sanitizeRename(tc.in, tc.old)
		if (err != nil) != tc.bad || got != tc.want {
			t.Errorf("sanitizeRename(%q) = %q, %v", tc.in, got, err)
		}
	}
}

func TestLibraryRename(t *testing.T) {
	e := newLibEnv(t)
	a := e.reg(t, "F/a.png", "m", 1)
	e.reg(t, "F/taken.png", "m", 2)
	o, err := e.svc.Rename(a.ID, "fresh")
	if err != nil || o.Name != "fresh.png" || o.ID != a.ID || filepath.Dir(o.Path) != filepath.Join(e.lib, "F") {
		t.Fatalf("%+v %v", o, err)
	}
	if _, err := os.Stat(filepath.Join(e.lib, "F", "fresh.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(e.lib, "F", "a.png")); !os.IsNotExist(err) {
		t.Fatal("old name still there")
	}
	got, _ := e.db.GetOutput(context.Background(), a.ID)
	if got.Path != o.Path {
		t.Fatalf("row not moved: %s", got.Path)
	}
	if len(e.events) == 0 || e.events[len(e.events)-1] != core.EventLibraryAdded {
		t.Fatalf("events = %v", e.events)
	}
	if _, err := e.svc.Rename(a.ID, "taken"); err == nil {
		t.Fatal("overwrote")
	}
	if b, _ := os.ReadFile(filepath.Join(e.lib, "F", "taken.png")); string(b) != "data-F/taken.png" {
		t.Fatalf("taken changed: %q", b)
	}
	if _, err := e.svc.Rename(a.ID, "NUL"); err == nil {
		t.Fatal("reserved accepted")
	}
	if o2, err := e.svc.Rename(a.ID, "fresh.png"); err != nil || o2.Name != "fresh.png" {
		t.Fatalf("same name: %+v %v", o2, err)
	}
	// case-only rename
	if o3, err := e.svc.Rename(a.ID, "FRESH.png"); err != nil || o3.Name != "FRESH.png" {
		t.Fatalf("case rename: %+v %v", o3, err)
	}
	// outputs outside the library are refused
	outside := filepath.Join(t.TempDir(), "o.png")
	write(t, outside, []byte("x"))
	ob, _ := e.db.UpsertOutput(context.Background(), core.Output{ID: core.NewID(), ModuleID: "m", Path: outside, Name: "o.png", Kind: core.KindImage, CreatedAt: 1, Tags: []string{}})
	if _, err := e.svc.Rename(ob.ID, "x"); err == nil {
		t.Fatal("renamed outside the library")
	}
	if _, err := e.svc.Rename("nope", "x"); err == nil {
		t.Fatal("unknown id")
	}
}

func TestLibraryTrash(t *testing.T) {
	e := newLibEnv(t)
	a := e.reg(t, "F/a.png", "m", 1)
	b := e.reg(t, "F/b.png", "m", 2)
	c := e.reg(t, "F/c.png", "m", 3)
	loose := filepath.Join(e.lib, "F", "loose.txt")
	write(t, loose, []byte("x"))
	outside := filepath.Join(t.TempDir(), "o.txt")
	write(t, outside, []byte("x"))
	inSupport := filepath.Join(e.support, "keep.txt")
	write(t, inSupport, []byte("x"))
	outsideLinked := filepath.Join(t.TempDir(), "target")
	write(t, filepath.Join(outsideLinked, "z.txt"), []byte("x"))
	link(t, outsideLinked, filepath.Join(e.lib, "Lnk"))
	e.fake.Fail = map[string]error{b.Path: errors.New("in use")}

	res, err := e.svc.Trash([]string{a.ID, b.ID, "ghost"}, []string{loose, outside, inSupport, e.lib,
		filepath.Join(e.lib, "F"), filepath.Join(e.lib, "Lnk", "z.txt"), "relative.txt", filepath.Join(e.lib, "F", "nope.txt"), a.Path})
	if err != nil {
		t.Fatal(err)
	}
	trashed := map[string]bool{}
	for _, p := range res.Trashed {
		trashed[p] = true
	}
	if len(res.Trashed) != 2 || !trashed[a.Path] || !trashed[loose] {
		t.Fatalf("trashed = %v", res.Trashed)
	}
	for _, p := range []string{b.Path, outside, inSupport, e.lib, filepath.Join(e.lib, "F"), filepath.Join(e.lib, "Lnk", "z.txt"), "relative.txt", filepath.Join(e.lib, "F", "nope.txt"), "ghost"} {
		if _, ok := res.Failed[p]; !ok {
			t.Errorf("%q should have failed; failed = %v", p, res.Failed)
		}
	}
	if len(e.fake.Trashed) != 2 {
		t.Fatalf("fake trashed %v", e.fake.Trashed)
	}
	if _, err := e.db.GetOutput(context.Background(), a.ID); err == nil {
		t.Error("a still registered")
	}
	if _, err := e.db.GetOutput(context.Background(), b.ID); err != nil {
		t.Error("failed b was forgotten")
	}
	if _, err := e.db.GetOutput(context.Background(), c.ID); err != nil {
		t.Error("c was forgotten")
	}
	if len(e.events) == 0 || e.events[len(e.events)-1] != core.EventLibraryRemoved {
		t.Fatalf("events = %v", e.events)
	}

	e.fake.Off = true
	if e.svc.TrashAvailable() {
		t.Error("available when off")
	}
	if _, err := e.svc.Trash([]string{c.ID}, nil); err == nil {
		t.Error("trashed with the trash off")
	}
}

func TestCopyAll(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(t.TempDir(), "a.png")
	write(t, src, []byte("one"))
	write(t, filepath.Join(dir, "a.png"), []byte("existing"))
	if err := copyAll([]string{src, src}, dir); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"a.png": "existing", "a (2).png": "one", "a (3).png": "one"} {
		if b, _ := os.ReadFile(filepath.Join(dir, name)); string(b) != want {
			t.Errorf("%s = %q", name, b)
		}
	}
	if err := copyAll([]string{filepath.Join(dir, "missing.png")}, dir); err == nil {
		t.Error("missing source reported ok")
	}
}
