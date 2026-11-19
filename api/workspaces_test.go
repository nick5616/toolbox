package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/workspace"
)

type emitLog struct{ names []string }

func (e *emitLog) Emit(n string, _ any) { e.names = append(e.names, n) }

func wsEnv(t *testing.T) string {
	t.Helper()
	global := filepath.Join(t.TempDir(), "global")
	if err := os.MkdirAll(global, 0o755); err != nil {
		t.Fatal(err)
	}
	return global
}

func personalService(t *testing.T) (*WorkspacesService, *[][]string, *emitLog) {
	t.Helper()
	global := wsEnv(t)
	var relaunched [][]string
	em := &emitLog{}
	s := &WorkspacesService{
		Boot: workspace.Boot{
			Info:      workspace.Info{ID: workspace.PersonalID, Name: "Personal", Kind: workspace.KindPersonal, Current: true},
			Paths:     core.NewPaths(global),
			GlobalDir: global,
		},
		Relaunch: func(a []string) error { relaunched = append(relaunched, a); return nil },
		Em:       em,
	}
	return s, &relaunched, em
}

func TestWorkspacesCreateListSwitch(t *testing.T) {
	s, relaunched, _ := personalService(t)
	if cur := s.Current(); cur.ID != workspace.PersonalID {
		t.Fatalf("current = %+v", cur)
	}
	root := filepath.Join(t.TempDir(), "Demo")
	info, err := s.Create(workspace.CreateRequest{Name: "Demo", Root: root, Kind: workspace.KindDemo, Present: true})
	if err != nil {
		t.Fatal(err)
	}
	list, _ := s.List()
	if len(list) != 2 || list[0].ID != workspace.PersonalID || !list[0].Current || list[1].ID != info.ID || list[1].Current {
		t.Fatalf("list = %+v", list)
	}
	if len(*relaunched) != 0 {
		t.Fatal("Create switched")
	}
	// duplicate name and a root inside the global dir are refused
	if _, err := s.Create(workspace.CreateRequest{Name: "demo", Root: filepath.Join(t.TempDir(), "x")}); err == nil {
		t.Error("duplicate name accepted")
	}
	if _, err := s.Create(workspace.CreateRequest{Name: "In", Root: filepath.Join(s.Boot.GlobalDir, "ws")}); err == nil {
		t.Error("root inside the global support dir accepted")
	}
	if err := s.Switch(info.ID); err != nil {
		t.Fatal(err)
	}
	if got := (*relaunched)[0]; len(got) != 2 || got[0] != "--workspace" || got[1] != info.Root {
		t.Fatalf("relaunch args = %v", got)
	}
	if err := s.Switch(workspace.PersonalID); err != nil {
		t.Fatal(err)
	}
	if err := s.Switch("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown: %v", err)
	}
	// a missing folder can't be switched to
	os.RemoveAll(info.Root)
	if err := s.Switch(info.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("missing: %v", err)
	}
	list, _ = s.List()
	if !list[1].Missing {
		t.Error("not Missing")
	}
	if err := s.Remove(info.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(workspace.PersonalID); err == nil {
		t.Error("removed Personal")
	}
	if err := s.Rename(workspace.PersonalID, "X"); err == nil {
		t.Error("renamed Personal")
	}
}

func TestWorkspacesInsideWorkspace(t *testing.T) {
	global := wsEnv(t)
	st := workspace.Store{Dir: global}
	root := filepath.Join(t.TempDir(), "Demo")
	info, err := st.Create(workspace.CreateRequest{Name: "Demo", Root: root, Kind: workspace.KindDemo, Present: true}, workspace.Guard{})
	if err != nil {
		t.Fatal(err)
	}
	info.Current = true
	em := &emitLog{}
	var relaunched [][]string
	s := &WorkspacesService{
		Boot: workspace.Boot{
			Info: info, Paths: core.NewPaths(workspace.SupportDirOf(root)), GlobalDir: global, LibraryDir: workspace.LibraryDirOf(root),
		},
		Relaunch: func(a []string) error { relaunched = append(relaunched, a); return nil },
		Em:       em,
	}
	// Remove of the open workspace is refused; Switch to Personal asks for it by id
	if err := s.Remove(info.ID); err == nil {
		t.Error("removed the open workspace")
	}
	if err := s.Switch(workspace.PersonalID); err != nil || relaunched[0][1] != workspace.PersonalID {
		t.Errorf("switch personal: %v %v", err, relaunched)
	}
	if err := s.Switch(info.ID); err != nil || len(relaunched) != 1 {
		t.Errorf("switch to self: %v", err)
	}
	// Rename emits workspace:changed for the open one
	if err := s.Rename(info.ID, "Showroom"); err != nil {
		t.Fatal(err)
	}
	if s.Current().Name != "Showroom" || len(em.names) != 1 || em.names[0] != workspace.EventChanged {
		t.Errorf("rename: %q %v", s.Current().Name, em.names)
	}
	// Present
	if err := s.SetPresent(false); err != nil {
		t.Fatal(err)
	}
	if s.Presenter().On || s.Current().Present {
		t.Error("present still on")
	}
	got, _ := workspace.ReadInfo(root)
	if got.Present {
		t.Error("workspace.json not updated")
	}
	if err := s.SetPresent(true); err != nil || !s.Presenter().On {
		t.Fatal(err)
	}
	if p := s.Presenter().Path(filepath.Join(root, "Library", "a.png")); p != "Showroom/Library/a.png" {
		t.Errorf("presenter path = %q", p)
	}
	// Restore and Tidy need a job manager
	if _, err := s.Restore(); err == nil {
		t.Error("restore without baseline accepted")
	}
	if _, err := s.Tidy(); err == nil {
		t.Error("tidy without jobs accepted") // Jobs is nil here
	}

	// TidyPreview: every library file counts (no manifest), display paths are presented
	lib := workspace.LibraryDirOf(root)
	os.MkdirAll(filepath.Join(lib, "Demo Footage"), 0o755)
	os.WriteFile(filepath.Join(lib, "Demo Footage", "keep.mp4"), []byte("k"), 0o644)
	os.WriteFile(filepath.Join(lib, "stem.flac"), []byte("12345"), 0o644)
	plan, err := s.TidyPreview()
	if err != nil {
		t.Fatal(err)
	}
	if plan.Files != 1 || plan.Bytes != 5 || len(plan.Sample) != 1 || plan.Sample[0] != "Showroom/Library/stem.flac" {
		t.Errorf("plan = %+v", plan)
	}
}

func TestWorkspacesPersonalAndSandbox(t *testing.T) {
	s, _, _ := personalService(t)
	for name, err := range map[string]error{
		"present": s.SetPresent(true),
		"tidy":    func() error { _, e := s.Tidy(); return e }(),
		"restore": func() error { _, e := s.Restore(); return e }(),
		"preview": func() error { _, e := s.TidyPreview(); return e }(),
	} {
		if !core.IsCode(err, core.CodeValidation) {
			t.Errorf("personal %s: %v", name, err)
		}
	}
	plan, _ := s.TidyPreview()
	if plan.Sample == nil {
		t.Error("Sample must be non-nil")
	}

	sb := &WorkspacesService{Boot: workspace.Boot{
		Info:      workspace.Info{ID: "sandbox", Name: "Dev sandbox", Kind: workspace.KindSandbox, Current: true},
		Sandboxed: true,
	}}
	if list, _ := sb.List(); len(list) != 1 || list[0].ID != "sandbox" {
		t.Errorf("sandbox list = %+v", list)
	}
	if _, err := sb.Create(workspace.CreateRequest{Name: "A", Root: t.TempDir()}); err == nil {
		t.Error("sandbox Create accepted")
	}
	if err := sb.Switch("x"); err == nil || !strings.Contains(err.Error(), "sandbox") {
		t.Errorf("sandbox switch: %v", err)
	}
	if _, err := os.Stat(filepath.Join("", workspace.ListFile)); err == nil {
		t.Error("a workspaces.json appeared in the working dir")
	}
}
