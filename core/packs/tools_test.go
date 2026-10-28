package packs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/store"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func newSettings(t *testing.T, support, lib string) *core.SettingsService {
	t.Helper()
	db, err := store.Open(filepath.Join(support, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st, err := core.NewSettingsService(db, nil, lib)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestFinishSetup(t *testing.T) {
	support := t.TempDir()
	st := newSettings(t, support, t.TempDir())
	s := New(Config{Paths: core.NewPaths(support), Settings: st})
	if st.Current().Setup.Done {
		t.Fatal("done at start")
	}
	if err := s.FinishSetup(); err != nil || !st.Current().Setup.Done {
		t.Errorf("FinishSetup: %v %+v", err, st.Current().Setup)
	}
}

// ---- ResolveToolsDir --------------------------------------------------------

func TestResolveToolsDir(t *testing.T) {
	f := newFixture(t, win, "amd64")
	root := t.TempDir()

	empty := filepath.Join(root, "empty")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	marked := filepath.Join(root, "marked")
	write(t, filepath.Join(marked, core.ToolsMarkerFile), "")
	write(t, filepath.Join(marked, "stuff.txt"), "x")
	full := filepath.Join(root, "full")
	write(t, filepath.Join(full, "photo.jpg"), "x")
	missing := filepath.Join(root, "new", "folder")
	fullWithSub := filepath.Join(root, "full2")
	write(t, filepath.Join(fullWithSub, "a.txt"), "x")
	write(t, filepath.Join(fullWithSub, toolsSubfolder, "other.txt"), "x")

	for _, c := range []struct {
		name, in, want string
		wantErr        bool
	}{
		{"empty folder as is", empty, empty, false},
		{"marked folder as is", marked, marked, false},
		{"nonexistent as is", missing, missing, false},
		{"folder with content gets a subfolder", full, filepath.Join(full, toolsSubfolder), false},
		{"existing foreign subfolder refused", fullWithSub, "", true},
		{"the support dir itself is fine", f.support, f.support, false},
		{"inside the support dir refused", filepath.Join(f.support, "x"), "", true},
		{"empty path refused", "", "", true},
	} {
		got, err := f.s.ResolveToolsDir(c.in)
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("%s: got %q, %v; want %q (err %v)", c.name, got, err, c.want, c.wantErr)
		}
	}
	file := filepath.Join(root, "file.txt")
	write(t, file, "x")
	if _, err := f.s.ResolveToolsDir(file); err == nil {
		t.Error("a file was accepted")
	}
}

func TestResolveToolsDirRefusesLibrary(t *testing.T) {
	support := t.TempDir()
	lib := t.TempDir()
	st := newSettings(t, support, lib)
	s := New(Config{Paths: core.NewPaths(support), Settings: st})
	for _, in := range []string{lib, filepath.Join(lib, "Tools")} {
		if _, err := s.ResolveToolsDir(in); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%s accepted: %v", in, err)
		}
	}
	// The parent of the library is fine when it has content (gets a subfolder),
	// as long as the subfolder isn't inside the library.
	parent := filepath.Dir(lib)
	if got, err := s.ResolveToolsDir(parent); err != nil || strings.HasPrefix(got, lib) {
		t.Errorf("parent: %q %v", got, err)
	}
}

// ---- Install with another tools folder --------------------------------------

func TestInstallToNewToolsDirWritesPointerAndPending(t *testing.T) {
	f := newFixture(t, win, "amd64")
	newDir := filepath.Join(t.TempDir(), "Toolbox Tools")
	res, err := f.s.Install([]string{"image", "media", "media"}, newDir)
	if err != nil || !res.Restart || len(res.Jobs) != 0 {
		t.Fatalf("res %+v err %v", res, err)
	}
	if got := core.ReadToolsPointer(f.support); got != filepath.Clean(newDir) {
		t.Errorf("pointer %q", got)
	}
	if !exists(filepath.Join(newDir, core.ToolsMarkerFile)) {
		t.Error("marker missing")
	}
	var pf pendingFile
	b, err := os.ReadFile(filepath.Join(f.support, core.SetupPendingFile))
	if err != nil || json.Unmarshal(b, &pf) != nil {
		t.Fatal(err)
	}
	if strings.Join(pf.Packs, ",") != "media,image" { // catalog order, deduplicated
		t.Errorf("pending %v", pf.Packs)
	}

	// Next start: the pending file is read and deleted.
	restarted := New(Config{Paths: core.NewPathsWithTools(f.support, newDir)})
	got := restarted.StartupTasks()
	if strings.Join(got, ",") != "media,image" {
		t.Errorf("startup packs %v", got)
	}
	if exists(filepath.Join(f.support, core.SetupPendingFile)) {
		t.Error("pending file not deleted")
	}
	if again := restarted.StartupTasks(); again != nil {
		t.Errorf("second start: %v", again)
	}
}

func TestInstallToNewToolsDirRefusals(t *testing.T) {
	f := newFixture(t, win, "amd64")
	other := filepath.Join(t.TempDir(), "t")
	write(t, filepath.Join(f.paths.BinDir, "yt-dlp.exe"), "x") // something already installed
	if _, err := f.s.Install([]string{"media"}, other); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("with tools installed: %v", err)
	}
	f2 := newFixture(t, win, "amd64")
	f2.s.cfg.Paths.ToolsDirFromEnv = true
	if _, err := f2.s.Install([]string{"media"}, other); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("env-set tools dir: %v", err)
	}
	f3 := newFixture(t, win, "amd64")
	if _, err := f3.s.Install([]string{"media"}, filepath.Join(f3.support, "inside")); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("inside support: %v", err)
	}
	if _, err := f3.s.Install([]string{"bogus"}, ""); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown pack: %v", err)
	}
	if _, err := f3.s.Install(nil, ""); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("no packs: %v", err)
	}
}

// ---- Disk / ToolsDir --------------------------------------------------------

func TestDiskAndToolsDir(t *testing.T) {
	f := newFixture(t, win, "amd64")
	d, err := f.s.Disk("")
	if err != nil || d.Total <= 0 || d.Free < 0 || d.Path != f.paths.ToolsDir {
		t.Errorf("disk %+v %v", d, err)
	}
	if d2, err := f.s.Disk(filepath.Join(f.paths.ToolsDir, "not", "yet")); err != nil || d2.Total != d.Total {
		t.Errorf("child disk %+v %v", d2, err)
	}
	info := f.s.ToolsDir()
	if info.Path != f.paths.ToolsDir || info.IsDefault || !info.Available {
		t.Errorf("tools dir %+v", info)
	}
}

// ---- move -------------------------------------------------------------------

type moveFixture struct {
	*fixture
	old string
}

func newMoveFixture(t *testing.T) *moveFixture {
	f := newFixture(t, win, "amd64")
	old := f.paths.ToolsDir
	write(t, filepath.Join(old, "bin", "ffmpeg", "ffmpeg.exe"), "ffmpeg-bytes")
	write(t, filepath.Join(old, "bin", "yt-dlp.exe"), "ytdlp")
	write(t, filepath.Join(old, "python", "cpython-3.12", "python.exe"), "py")
	write(t, filepath.Join(old, "sidecar", "pyproject.toml"), "[project]")
	write(t, filepath.Join(old, "sidecar", ".venv", "pyvenv.cfg"),
		"home = "+filepath.Join(old, "python", "cpython-3.12")+"\ninclude-system-site-packages = false\nversion = 3.12.4\n")
	write(t, filepath.Join(old, "models", "whisper", "small", "model.bin"), strings.Repeat("m", 5000))
	return &moveFixture{fixture: f, old: old}
}

func (m *moveFixture) run(ctx context.Context, target string) (*progress, error) {
	mod, _ := m.reg.Get(MoveModuleID)
	job, p := m.job(MoveOptions{Path: target})
	return p, mod.Run(ctx, job)
}

func TestMoveCopiesRewritesAndCleansOnNextStart(t *testing.T) {
	m := newMoveFixture(t)
	stopped := false
	m.s.cfg.StopEngines = func() { stopped = true }
	target := filepath.Join(t.TempDir(), "Toolbox Tools")

	p, err := m.run(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Error("engines not stopped")
	}
	monotonic(t, p.pcts)
	if p.pcts[len(p.pcts)-1] != 1 {
		t.Errorf("progress %v", p.pcts)
	}

	for _, rel := range []string{"bin/ffmpeg/ffmpeg.exe", "bin/yt-dlp.exe", "python/cpython-3.12/python.exe", "models/whisper/small/model.bin", "sidecar/pyproject.toml"} {
		if !exists(filepath.Join(target, filepath.FromSlash(rel))) {
			t.Errorf("%s not copied", rel)
		}
	}
	cfg, _ := os.ReadFile(filepath.Join(target, "sidecar", ".venv", "pyvenv.cfg"))
	wantHome := "home = " + filepath.Join(target, "python", "cpython-3.12")
	if !strings.Contains(string(cfg), wantHome+"\n") || !strings.Contains(string(cfg), "include-system-site-packages = false") {
		t.Errorf("pyvenv.cfg:\n%s\nwant %q", cfg, wantHome)
	}
	if !exists(filepath.Join(target, core.ToolsMarkerFile)) {
		t.Error("marker missing")
	}
	if got := core.ReadToolsPointer(m.support); got != filepath.Clean(target) {
		t.Errorf("pointer %q", got)
	}
	cl, _ := os.ReadFile(filepath.Join(m.support, core.ToolsMoveCleanupFile))
	if strings.TrimSpace(string(cl)) != filepath.Clean(m.old) {
		t.Errorf("cleanup file %q", cl)
	}
	if !exists(filepath.Join(m.old, "bin", "yt-dlp.exe")) {
		t.Fatal("old files removed before restart")
	}

	// Next start with the new folder: the old tools go away.
	next := New(Config{Paths: core.NewPathsWithTools(m.support, target)})
	next.StartupTasks()
	for _, d := range []string{"bin", "python", "sidecar", "models"} {
		if exists(filepath.Join(m.old, d)) {
			t.Errorf("old %s survived cleanup", d)
		}
	}
	if exists(filepath.Join(m.support, core.ToolsMoveCleanupFile)) {
		t.Error("cleanup file survived")
	}
}

func TestMoveCleanupWaitsForMarker(t *testing.T) {
	support, old, nw := t.TempDir(), t.TempDir(), t.TempDir() // nw has no marker
	write(t, filepath.Join(old, "bin", "x"), "x")
	write(t, filepath.Join(support, core.ToolsMoveCleanupFile), old+"\n")
	New(Config{Paths: core.NewPathsWithTools(support, nw)}).StartupTasks()
	if !exists(filepath.Join(old, "bin", "x")) {
		t.Fatal("old tools deleted although the new folder has no marker")
	}
	if !exists(filepath.Join(support, core.ToolsMoveCleanupFile)) {
		t.Error("cleanup file dropped early")
	}
	// Reverted to the old folder: nothing to clean, the file goes.
	New(Config{Paths: core.NewPathsWithTools(support, old)}).StartupTasks()
	if !exists(filepath.Join(old, "bin", "x")) || exists(filepath.Join(support, core.ToolsMoveCleanupFile)) {
		t.Error("revert handled wrongly")
	}
}

func TestMoveCancelRemovesPartialCopy(t *testing.T) {
	m := newMoveFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	m.s.cfg.StopEngines = cancel // cancel as the copy is about to start
	target := filepath.Join(t.TempDir(), "dest")
	_, err := m.run(ctx, target)
	if !core.IsCode(err, core.CodeCancelled) {
		t.Fatalf("err %v", err)
	}
	if exists(target) {
		t.Error("partial copy left behind")
	}
	if core.ReadToolsPointer(m.support) != m.support {
		t.Error("pointer written for a cancelled move")
	}
	if !exists(filepath.Join(m.old, "bin", "yt-dlp.exe")) {
		t.Error("original damaged")
	}
	// An existing target folder survives, minus what was copied.
	m2 := newMoveFixture(t)
	ctx2, cancel2 := context.WithCancel(context.Background())
	m2.s.cfg.StopEngines = cancel2
	existing := t.TempDir()
	write(t, filepath.Join(existing, "keep.txt"), "k")
	if _, err := m2.run(ctx2, existing); !core.IsCode(err, core.CodeCancelled) {
		t.Fatal(err)
	}
	if !exists(filepath.Join(existing, "keep.txt")) || exists(filepath.Join(existing, "bin")) {
		t.Error("existing folder not restored")
	}
}

func TestMoveRefusals(t *testing.T) {
	m := newMoveFixture(t)
	nonEmpty := t.TempDir()
	write(t, filepath.Join(nonEmpty, "bin", "other.exe"), "x")
	if _, err := m.run(context.Background(), nonEmpty); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("non-empty target: %v", err)
	}
	if _, err := m.run(context.Background(), m.old); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("same folder: %v", err)
	}
	if _, err := m.run(context.Background(), filepath.Join(m.old, "bin", "sub")); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("inside the tools: %v", err)
	}
	if _, err := m.run(context.Background(), filepath.Join(m.support, "inside")); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("inside support: %v", err)
	}
	m.s.cfg.Paths.ToolsDirFromEnv = true
	if _, err := m.run(context.Background(), t.TempDir()); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("env-set: %v", err)
	}
	if _, err := m.s.MoveToolsDir(t.TempDir()); err == nil {
		t.Error("MoveToolsDir without jobs or with env-set accepted")
	}
}

func TestRewriteVenvHome(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "pyvenv.cfg")
	oldPy, newPy := filepath.Join(dir, "old", "python"), filepath.Join(dir, "new", "python")
	if err := rewriteVenvHome(cfg, oldPy, newPy); err != nil {
		t.Errorf("missing file: %v", err)
	}
	write(t, cfg, "home = "+filepath.Join(oldPy, "cpython-3.12", "bin")+"\nexecutable = "+filepath.Join(oldPy, "cpython-3.12", "bin", "python")+"\n")
	if err := rewriteVenvHome(cfg, oldPy, newPy); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(cfg)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if lines[0] != "home = "+filepath.Join(newPy, "cpython-3.12", "bin") {
		t.Errorf("home: %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "executable = "+oldPy) {
		t.Errorf("other keys must be untouched: %q", lines[1])
	}
	// A home elsewhere is left alone.
	write(t, cfg, "home = /usr/lib/python3\n")
	if err := rewriteVenvHome(cfg, oldPy, newPy); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(cfg); string(b) != "home = /usr/lib/python3\n" {
		t.Errorf("foreign home rewritten: %q", b)
	}
}
