package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/trash"
	ws "toolbox/core/workspace"
)

type rec struct {
	mu       sync.Mutex
	logs     []string
	progress []string
	result   json.RawMessage
	outputs  []string
	registry []string
}

func (r *rec) logText() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.logs, "\n")
}

func (r *rec) lastProgress() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.progress) == 0 {
		return ""
	}
	return r.progress[len(r.progress)-1]
}

func (r *rec) res(t *testing.T) Result {
	t.Helper()
	var out Result
	if err := json.Unmarshal(r.result, &out); err != nil {
		t.Fatalf("result: %v (%s)", err, r.result)
	}
	return out
}

func (r *rec) register(p string) error {
	r.mu.Lock()
	r.registry = append(r.registry, p)
	r.mu.Unlock()
	return nil
}

func runJob(t *testing.T, m *Module, a Action, tool func(string) (string, error)) (*rec, error) {
	t.Helper()
	r := &rec{}
	opts, _ := json.Marshal(Options{Action: a})
	job := core.NewJobContext(core.JobContext{ID: "J1", ModuleID: ModuleID, Options: opts, TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(_ float64, msg string) { r.mu.Lock(); r.progress = append(r.progress, msg); r.mu.Unlock() },
		Log:      func(_ core.LogStream, l string) { r.mu.Lock(); r.logs = append(r.logs, l); r.mu.Unlock() },
		Result:   func(b json.RawMessage) { r.result = b },
		Output: func(p string) (core.Output, error) {
			r.mu.Lock()
			r.outputs = append(r.outputs, p)
			r.mu.Unlock()
			return core.Output{}, nil
		},
		Tool: tool,
	})
	return r, m.Run(context.Background(), job)
}

func write(t *testing.T, root, rel, content string) string {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// hashTree returns rel → sha256 for every file under dir (hidden included).
func hashTree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		out[filepath.ToSlash(rel)] = sha(string(b))
		return nil
	})
	return out
}

func equalMaps(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

type fixture struct {
	baseline, root, lib string
	info                ws.Info
	m                   *Module
	trash               *trash.Fake
	forgot              []string
	cleared             int
	active              int
	reg                 *rec
}

func newFixture(t *testing.T, kind ws.Kind, strip bool, exclude []string) *fixture {
	t.Helper()
	f := &fixture{baseline: t.TempDir(), root: filepath.Join(t.TempDir(), "ws"), trash: &trash.Fake{}, reg: &rec{}}
	f.lib = ws.LibraryDirOf(f.root)
	f.info = ws.Info{
		ID: "abc", Name: "Demo", Kind: kind, Root: f.root, Baseline: f.baseline,
		Keep: []string{"Demo Footage", "Extras"}, Exclude: exclude, StripLocation: strip, Current: true,
	}
	os.MkdirAll(f.lib, 0o755)
	f.m = New(Config{
		Boot:     ws.Boot{Info: f.info, Paths: core.NewPaths(ws.SupportDirOf(f.root))},
		Trash:    f.trash,
		Register: f.reg.register,
		Forget:   func(p []string) { f.forgot = append(f.forgot, p...) },
		ClearHistory: func(context.Context) (int, error) {
			f.cleared++
			return 7, nil
		},
		ActiveJobs: func(context.Context, string) int { return f.active },
		Strip: func(_ context.Context, _ string, file string) error {
			fh, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				return err
			}
			defer fh.Close()
			_, err = fh.WriteString("<stripped>")
			return err
		},
	})
	return f
}

func makeLinks(t *testing.T, baseline string) (symlink, junction bool) {
	t.Helper()
	target := write(t, t.TempDir(), "outside/secret.txt", "secret")
	if os.Symlink(target, filepath.Join(baseline, "linkfile.txt")) == nil {
		symlink = true
	}
	if os.Symlink(filepath.Dir(target), filepath.Join(baseline, "linkdir")) == nil {
		symlink = true
	}
	if runtime.GOOS == "windows" {
		cmd := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(baseline, "junction"), filepath.Dir(target))
		if cmd.Run() == nil {
			junction = true
		}
	}
	return
}

func TestSeed(t *testing.T) {
	f := newFixture(t, ws.KindDemo, false, []string{"skip/*", "*.TMP"})
	write(t, f.baseline, "a.txt", "alpha")
	write(t, f.baseline, "sub/b.png", "bravo")
	write(t, f.baseline, "Demo Footage/clip.mp4", "clip")
	write(t, f.baseline, ".hidden.txt", "hidden")
	write(t, f.baseline, ".hiddendir/x.txt", "x")
	write(t, f.baseline, "skip/me.txt", "excluded")
	write(t, f.baseline, "junk.tmp", "excluded by case-insensitive glob")
	old := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)
	os.Chtimes(filepath.Join(f.baseline, "a.txt"), old, old)
	sym, junc := makeLinks(t, f.baseline)
	t.Logf("symlinks: %v junction: %v", sym, junc)
	before := hashTree(t, f.baseline)

	r, err := runJob(t, f.m, ActionSeed, nil)
	if err != nil {
		t.Fatal(err)
	}
	// only the real, visible, non-excluded files arrive
	var got []string
	filepath.WalkDir(f.lib, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(f.lib, p)
			got = append(got, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(got)
	if want := "Demo Footage/clip.mp4,a.txt,sub/b.png"; strings.Join(got, ",") != want {
		t.Fatalf("library = %v, want %s", got, want)
	}
	if !equalMaps(before, hashTree(t, f.baseline)) {
		t.Fatal("the baseline changed")
	}
	st, _ := os.Stat(filepath.Join(f.lib, "a.txt"))
	if !st.ModTime().Equal(old) {
		t.Errorf("mtime = %v, want %v", st.ModTime(), old)
	}
	man, ok, err := ws.ReadManifest(f.root)
	if err != nil || !ok || len(man.Files) != 3 {
		t.Fatalf("manifest = %+v %v %v", man, ok, err)
	}
	for _, e := range man.Files {
		if e.Rel == "a.txt" && (e.SrcSha256 != sha("alpha") || e.Sha256 != sha("alpha") || e.Size != 5) {
			t.Errorf("a.txt entry = %+v", e)
		}
	}
	if len(f.reg.registry) != 3 {
		t.Errorf("registered %v", f.reg.registry)
	}
	if res := r.res(t); res.Copied != 3 || len(res.Skipped) != 0 {
		t.Errorf("result = %+v", res)
	}
	if got := r.lastProgress(); got != "Copied 3 files" {
		t.Errorf("last progress = %q", got)
	}
	entries, _ := os.ReadDir(filepath.Join(f.lib, "sub"))
	for _, e := range entries {
		if strings.Contains(e.Name(), ".toolbox-copy") {
			t.Errorf("temp file left: %s", e.Name())
		}
	}
	for _, p := range []string{"linkfile.txt", "linkdir", "junction"} {
		if _, err := os.Lstat(filepath.Join(f.lib, p)); err == nil {
			t.Errorf("link %s was copied", p)
		}
	}
	if sym {
		if _, err := os.Stat(filepath.Join(f.lib, "secret.txt")); err == nil {
			t.Error("a link target was followed")
		}
	}
}

func TestSeedStripsLocationOnCopies(t *testing.T) {
	f := newFixture(t, ws.KindDemo, true, nil)
	write(t, f.baseline, "photo.JPG", "jpegbytes")
	write(t, f.baseline, "doc.txt", "text")
	tool := func(id string) (string, error) {
		if id != "exiftool" {
			t.Errorf("tool %q", id)
		}
		return "fake-exiftool", nil
	}
	r, err := runJob(t, f.m, ActionSeed, tool)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(f.lib, "photo.JPG"))
	if string(b) != "jpegbytes<stripped>" {
		t.Errorf("photo copy = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(f.lib, "doc.txt")); string(b) != "text" {
		t.Errorf("doc copy = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(f.baseline, "photo.JPG")); string(b) != "jpegbytes" {
		t.Error("the baseline photo was modified")
	}
	man, _, _ := ws.ReadManifest(f.root)
	for _, e := range man.Files {
		if e.Rel == "photo.JPG" && (e.SrcSha256 != sha("jpegbytes") || e.Sha256 != sha("jpegbytes<stripped>")) {
			t.Errorf("photo entry = %+v", e)
		}
	}
	if len(r.res(t).Unstripped) != 0 {
		t.Errorf("unstripped = %v", r.res(t).Unstripped)
	}
	// without ExifTool: copies are made, flagged and warned about
	f2 := newFixture(t, ws.KindDemo, true, nil)
	write(t, f2.baseline, "clip.mp4", "video")
	r2, err := runJob(t, f2.m, ActionSeed, func(string) (string, error) { return "", core.ErrDependencyMissing("exiftool", "") })
	if err != nil {
		t.Fatal(err)
	}
	if res := r2.res(t); len(res.Unstripped) != 1 || res.Unstripped[0] != "clip.mp4" {
		t.Errorf("unstripped = %v", res.Unstripped)
	}
	if !strings.Contains(r2.logText(), "WARNING") {
		t.Errorf("no warning in log: %s", r2.logText())
	}
}

func TestSeedSkipsFilesItCannotWrite(t *testing.T) {
	f := newFixture(t, ws.KindStandard, false, nil)
	write(t, f.baseline, "ok.txt", "fine")
	write(t, f.baseline, "locked.txt", "busy")
	// a non-empty folder where the copy must go makes the final rename fail
	write(t, f.lib, "locked.txt/in-the-way", "x")
	r, err := runJob(t, f.m, ActionSeed, nil)
	if err != nil {
		t.Fatal(err)
	}
	res := r.res(t)
	if res.Copied != 1 || len(res.Skipped) != 1 || res.Skipped[0] != "locked.txt" {
		t.Fatalf("result = %+v", res)
	}
	if !strings.Contains(r.logText(), "locked.txt") || !strings.Contains(r.logText(), "WARNING") {
		t.Errorf("log: %s", r.logText())
	}
	man, _, _ := ws.ReadManifest(f.root)
	if len(man.Files) != 1 || man.Files[0].Rel != "ok.txt" {
		t.Errorf("manifest = %+v", man)
	}
}

func TestSeedCancelWritesNoManifest(t *testing.T) {
	f := newFixture(t, ws.KindStandard, false, nil)
	write(t, f.baseline, "a.txt", "a")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	opts, _ := json.Marshal(Options{Action: ActionSeed})
	job := core.NewJobContext(core.JobContext{ID: "J", Options: opts}, core.JobHooks{})
	err := f.m.Run(ctx, job)
	if err == nil {
		t.Fatal("cancelled seed succeeded")
	}
	if _, ok, _ := ws.ReadManifest(f.root); ok {
		t.Fatal("manifest written after cancel")
	}
}

func TestSeedErrors(t *testing.T) {
	f := newFixture(t, ws.KindStandard, false, nil)
	f.m.cfg.Boot.Info.Baseline = filepath.Join(f.baseline, "nope")
	if _, err := runJob(t, f.m, ActionSeed, nil); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("missing baseline: %v", err)
	}
	f.m.cfg.Boot.Info.Baseline = ""
	if _, err := runJob(t, f.m, ActionSeed, nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("no baseline: %v", err)
	}
	// Personal has no baseline, restore or tidy
	p := New(Config{Boot: ws.Boot{Info: ws.Info{ID: ws.PersonalID, Kind: ws.KindPersonal}}})
	for _, a := range []Action{ActionSeed, ActionRestore, ActionTidy} {
		if _, err := runJob(t, p, a, nil); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("personal %s: %v", a, err)
		}
	}
}

func TestRestore(t *testing.T) {
	f := newFixture(t, ws.KindDemo, false, nil)
	write(t, f.baseline, "a.txt", "alpha")
	write(t, f.baseline, "b.txt", "bravo")
	write(t, f.baseline, "c.txt", "charlie")
	if _, err := runJob(t, f.m, ActionSeed, nil); err != nil {
		t.Fatal(err)
	}
	// nothing to do
	r, err := runJob(t, f.m, ActionRestore, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.lastProgress() != "Nothing to restore" || r.res(t).Copied != 0 {
		t.Errorf("idle restore: %q %+v", r.lastProgress(), r.res(t))
	}
	// a deleted copy, an edited copy (same size), a baseline file added later, and a user file
	os.Remove(filepath.Join(f.lib, "a.txt"))
	write(t, f.lib, "b.txt", "BRAVO")
	write(t, f.baseline, "d.txt", "delta")
	write(t, f.lib, "mine.txt", "mine")
	before := hashTree(t, f.baseline)
	r, err = runJob(t, f.m, ActionRestore, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.res(t).Copied != 3 || r.lastProgress() != "Restored 3 files" {
		t.Errorf("restore: %q %+v", r.lastProgress(), r.res(t))
	}
	for name, want := range map[string]string{"a.txt": "alpha", "b.txt": "bravo", "c.txt": "charlie", "d.txt": "delta", "mine.txt": "mine"} {
		if b, _ := os.ReadFile(filepath.Join(f.lib, name)); string(b) != want {
			t.Errorf("%s = %q, want %q", name, b, want)
		}
	}
	if !equalMaps(before, hashTree(t, f.baseline)) {
		t.Fatal("the baseline changed")
	}
	man, _, _ := ws.ReadManifest(f.root)
	if len(man.Files) != 4 {
		t.Errorf("manifest has %d entries", len(man.Files))
	}
	// a second restore does nothing
	if r, _ = runJob(t, f.m, ActionRestore, nil); r.res(t).Copied != 0 {
		t.Errorf("second restore copied %d", r.res(t).Copied)
	}
}

func TestPlanTidyAndTidy(t *testing.T) {
	f := newFixture(t, ws.KindDemo, false, nil)
	write(t, f.baseline, "base.txt", "base")
	write(t, f.baseline, "Demo Footage/a.mp4", "a")
	if _, err := runJob(t, f.m, ActionSeed, nil); err != nil {
		t.Fatal(err)
	}
	stem := write(t, f.lib, "Stems/song (vocals).flac", "flac")
	out := write(t, f.lib, "Converted/x.mp3", "mp3")
	write(t, f.lib, "Demo Footage/mine.mp4", "kept: inside a keep folder")
	write(t, f.lib, "extras/z.txt", "kept: keep folders match case-insensitively")
	write(t, f.lib, ".DS_Store", "hidden")
	write(t, f.lib, "Stems/.cache", "hidden")
	sym, _ := makeLinks(t, f.lib)
	_ = sym

	plan, err := PlanTidy(context.Background(), f.info)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	var bytes int64
	for _, p := range plan {
		got = append(got, p.Path)
		bytes += p.Size
	}
	want := []string{out, stem}
	sort.Strings(want)
	if strings.Join(got, "|") != strings.Join(want, "|") || bytes != 7 {
		t.Fatalf("plan = %v (%d bytes), want %v", got, bytes, want)
	}

	// running jobs block it
	f.active = 2
	if _, err := runJob(t, f.m, ActionTidy, nil); err == nil || !strings.Contains(err.Error(), "Wait for 2 jobs to finish") {
		t.Fatalf("blocked tidy: %v", err)
	}
	if len(f.trash.Trashed) != 0 {
		t.Fatal("trashed while blocked")
	}
	f.active = 0
	r, err := runJob(t, f.m, ActionTidy, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res := r.res(t); res.Trashed != 2 || res.Cleared != 7 || len(res.Failed) != 0 {
		t.Errorf("result = %+v", res)
	}
	sort.Strings(f.trash.Trashed)
	if strings.Join(f.trash.Trashed, "|") != strings.Join(want, "|") {
		t.Errorf("trashed = %v", f.trash.Trashed)
	}
	if len(f.forgot) != 2 || f.cleared != 1 {
		t.Errorf("forget %v cleared %d", f.forgot, f.cleared)
	}
	// the Fake doesn't delete; baseline files and keep folders were never offered
	for _, p := range f.trash.Trashed {
		if strings.Contains(p, "base.txt") || strings.Contains(p, "Demo Footage") {
			t.Errorf("trashed %s", p)
		}
	}

	// Standard workspaces can't tidy; neither can a build without a trash
	std := newFixture(t, ws.KindStandard, false, nil)
	if _, err := runJob(t, std.m, ActionTidy, nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("standard tidy: %v", err)
	}
	f.trash.Off = true
	if _, err := runJob(t, f.m, ActionTidy, nil); !core.IsCode(err, core.CodeConflict) {
		t.Errorf("no trash: %v", err)
	}
}

func TestTidyReportsFailures(t *testing.T) {
	f := newFixture(t, ws.KindDemo, false, nil)
	write(t, f.baseline, "base.txt", "base")
	runJob(t, f.m, ActionSeed, nil)
	locked := write(t, f.lib, "locked.bin", "x")
	write(t, f.lib, "free.bin", "y")
	f.trash.Fail = map[string]error{locked: errors.New("in use")}
	r, err := runJob(t, f.m, ActionTidy, nil)
	if err != nil {
		t.Fatal(err)
	}
	res := r.res(t)
	if res.Trashed != 1 || len(res.Failed) != 1 || res.Failed[0] != locked {
		t.Errorf("result = %+v", res)
	}
	if !strings.Contains(r.lastProgress(), "1 couldn't be moved") {
		t.Errorf("progress = %q", r.lastProgress())
	}
}

func TestMatchesAny(t *testing.T) {
	for _, tt := range []struct {
		globs []string
		rel   string
		want  bool
	}{
		{[]string{"*.tmp"}, "a.TMP", true},
		{[]string{"*.tmp"}, "sub/a.tmp", false}, // path.Match: * doesn't cross /
		{[]string{"sub/*.tmp"}, "SUB/a.tmp", true},
		{[]string{"raw"}, "raw", true},
		{[]string{""}, "a", false},
		{nil, "a", false},
	} {
		if got := matchesAny(tt.globs, tt.rel); got != tt.want {
			t.Errorf("matchesAny(%v, %q) = %v", tt.globs, tt.rel, got)
		}
	}
}

func TestValidate(t *testing.T) {
	m := New(Config{})
	for _, a := range []string{"seed", "restore", "tidy"} {
		if err := m.Validate(nil, json.RawMessage(`{"action":"`+a+`"}`)); err != nil {
			t.Errorf("%s: %v", a, err)
		}
	}
	for _, raw := range []string{`{"action":"nuke"}`, `{`, `{}`} {
		if err := m.Validate(nil, json.RawMessage(raw)); err == nil {
			t.Errorf("%s accepted", raw)
		}
	}
	if d := m.Descriptor(); !d.Hidden || d.ID != ModuleID {
		t.Errorf("descriptor = %+v", d)
	}
}

func TestCheckInside(t *testing.T) {
	lib := filepath.Join(t.TempDir(), "Library")
	if err := checkInside(filepath.Join(lib, "a", "b.txt"), lib); err != nil {
		t.Error(err)
	}
	for _, p := range []string{lib, filepath.Join(lib, "..", "x"), filepath.Dir(lib)} {
		if checkInside(p, lib) == nil {
			t.Errorf("%s accepted", p)
		}
	}
}
