package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

// env points every OS config location at a temp dir and clears Toolbox's
// overrides, so no test touches the real %AppData%. It returns the global
// support dir.
func env(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	for _, k := range []string{"APPDATA", "XDG_CONFIG_HOME", "HOME", "USERPROFILE", "LOCALAPPDATA"} {
		t.Setenv(k, home)
	}
	for _, k := range []string{core.EnvSupportDir, core.EnvLibraryDir, core.EnvToolsDir, EnvWorkspace, EnvWorkspaceBaseline, EnvWorkspaceKind, EnvWorkspaceName} {
		t.Setenv(k, "")
	}
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	global := filepath.Join(base, "Toolbox")
	if err := os.MkdirAll(global, 0o755); err != nil {
		t.Fatal(err)
	}
	return global
}

func mustCreate(t *testing.T, st Store, name string, kind Kind) Info {
	t.Helper()
	root := filepath.Join(t.TempDir(), name)
	info, err := st.Create(CreateRequest{Name: name, Root: root, Kind: kind}, Guard{})
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	return info
}

func TestResolveOrder(t *testing.T) {
	global := env(t)
	st := Store{Dir: global}
	demo := mustCreate(t, st, "Demo", KindDemo)
	other := mustCreate(t, st, "Other", KindStandard)

	// 5. Personal
	b, err := Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	if b.Info.ID != PersonalID || b.Sandboxed || b.GlobalDir != global || b.LibraryDir != "" || b.Paths.SupportDir != global {
		t.Fatalf("personal boot = %+v", b)
	}

	// 4. active
	if err := st.SetActive(other.ID); err != nil {
		t.Fatal(err)
	}
	if b, _ = Resolve(nil); b.Info.ID != other.ID {
		t.Fatalf("active ignored: %+v", b.Info)
	}
	// 3. --workspace beats active (by id and by root)
	if b, _ = Resolve([]string{ArgWorkspace, demo.ID}); b.Info.ID != demo.ID {
		t.Fatalf("--workspace id: %+v", b.Info)
	}
	b, _ = Resolve([]string{ArgWorkspace + "=" + demo.Root})
	if b.Info.ID != demo.ID || b.LibraryDir != filepath.Join(demo.Root, "Library") || b.Paths.SupportDir != filepath.Join(demo.Root, ".toolbox") {
		t.Fatalf("--workspace root: %+v", b)
	}
	if b.Sandboxed || !b.Info.Current {
		t.Fatalf("flags: %+v", b)
	}
	// --workspace personal
	if b, _ = Resolve([]string{ArgWorkspace, "personal"}); b.Info.ID != PersonalID {
		t.Fatalf("--workspace personal: %+v", b.Info)
	}

	// 2. env workspace beats args, is sandboxed and creates the folder
	envRoot := filepath.Join(t.TempDir(), "envws")
	t.Setenv(EnvWorkspace, envRoot)
	t.Setenv(EnvWorkspaceKind, "demo")
	t.Setenv(EnvWorkspaceName, "Envy")
	b, err = Resolve([]string{ArgWorkspace, demo.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !b.Sandboxed || b.GlobalDir != "" || b.Info.Name != "Envy" || b.Info.Kind != KindDemo || b.LibraryDir != filepath.Join(envRoot, "Library") {
		t.Fatalf("env workspace: %+v", b)
	}
	if _, err := os.Stat(filepath.Join(envRoot, ".toolbox", "workspace.json")); err != nil {
		t.Fatal("workspace.json not written")
	}
	// second boot reads the same id
	b2, _ := Resolve(nil)
	if b2.Info.ID != b.Info.ID {
		t.Fatal("env workspace id changed between boots")
	}

	// 1. support dir beats everything
	sup := t.TempDir()
	t.Setenv(core.EnvSupportDir, sup)
	b, _ = Resolve([]string{ArgWorkspace, demo.ID})
	if b.Info.Kind != KindSandbox || !b.Sandboxed || b.Paths.SupportDir != sup || b.GlobalDir != "" || b.LibraryDir != "" {
		t.Fatalf("support dir: %+v", b)
	}
}

func TestResolveSandboxedNeverWritesGlobal(t *testing.T) {
	global := env(t)
	t.Setenv(EnvWorkspace, filepath.Join(t.TempDir(), "x"))
	if _, err := Resolve([]string{ArgWorkspace, "whatever"}); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(global); len(ents) != 0 {
		t.Fatalf("global support dir was written: %v", ents)
	}
}

func TestResolveAddsUnknownRoot(t *testing.T) {
	global := env(t)
	// a workspace made elsewhere (another machine's list)
	src := Store{Dir: t.TempDir()}
	info := mustCreate(t, src, "Away", KindStandard)
	b, err := Resolve([]string{ArgWorkspace, info.Root})
	if err != nil {
		t.Fatal(err)
	}
	if b.Info.Name != "Away" || b.Notice != "" {
		t.Fatalf("boot = %+v", b)
	}
	list, _ := Store{Dir: global}.List("")
	if len(list) != 2 || list[1].Root != info.Root {
		t.Fatalf("not added: %+v", list)
	}
	// a folder that isn't a workspace → Personal + notice
	b, _ = Resolve([]string{ArgWorkspace, t.TempDir()})
	if b.Info.ID != PersonalID || b.Notice == "" {
		t.Fatalf("bad root: %+v", b)
	}
}

func TestToolsFolderResolution(t *testing.T) {
	global := env(t)
	st := Store{Dir: global}
	demo := mustCreate(t, st, "Demo", KindStandard)
	args := []string{ArgWorkspace, demo.ID}

	b, _ := Resolve(args)
	if b.Paths.ToolsDir != global || b.Paths.BinDir != filepath.Join(global, "bin") {
		t.Fatalf("default tools = %q", b.Paths.ToolsDir)
	}
	moved := filepath.Join(t.TempDir(), "tools")
	if err := core.WriteToolsPointer(global, moved); err != nil {
		t.Fatal(err)
	}
	if b, _ = Resolve(args); b.Paths.ToolsDir != moved || b.Paths.ModelsDir != filepath.Join(moved, "models") || b.Paths.ToolsDirFromEnv {
		t.Fatalf("pointer tools = %+v", b.Paths)
	}
	// support-side paths stay in the workspace
	if b.Paths.TmpDir != filepath.Join(demo.Root, ".toolbox", "tmp") || b.Paths.DBPath != filepath.Join(demo.Root, ".toolbox", "toolbox.db") {
		t.Fatalf("support paths: %+v", b.Paths)
	}
	envTools := t.TempDir()
	t.Setenv(core.EnvToolsDir, envTools)
	if b, _ = Resolve(args); b.Paths.ToolsDir != envTools || !b.Paths.ToolsDirFromEnv {
		t.Fatalf("env tools = %+v", b.Paths)
	}
}

func TestValidation(t *testing.T) {
	global := env(t)
	st := Store{Dir: global}
	parent := t.TempDir()
	existing, err := st.Create(CreateRequest{Name: "Existing", Root: filepath.Join(parent, "existing")}, Guard{})
	if err != nil {
		t.Fatal(err)
	}
	nonEmpty := filepath.Join(parent, "nonempty")
	os.MkdirAll(nonEmpty, 0o755)
	os.WriteFile(filepath.Join(nonEmpty, "a.txt"), []byte("x"), 0o644)
	empty := filepath.Join(parent, "empty")
	os.MkdirAll(empty, 0o755)
	baseline := filepath.Join(parent, "baseline")
	os.MkdirAll(baseline, 0o755)
	lib := filepath.Join(parent, "PersonalLib")
	tools := filepath.Join(parent, "tools")
	g := Guard{Protected: []string{global, tools, lib}}

	tests := []struct {
		name string
		req  CreateRequest
		want string // substring of the message; "" = ok
	}{
		{"ok", CreateRequest{Name: "New", Root: filepath.Join(parent, "new")}, ""},
		{"ok empty folder", CreateRequest{Name: "New", Root: empty}, ""},
		{"ok baseline", CreateRequest{Name: "New", Root: filepath.Join(parent, "new"), Baseline: baseline}, ""},
		{"empty name", CreateRequest{Name: "  ", Root: filepath.Join(parent, "n")}, "name"},
		{"long name", CreateRequest{Name: strings.Repeat("x", 41), Root: filepath.Join(parent, "n")}, "name"},
		{"reserved", CreateRequest{Name: "personal", Root: filepath.Join(parent, "n")}, "taken"},
		{"duplicate ci", CreateRequest{Name: "EXISTING", Root: filepath.Join(parent, "n")}, "already exists"},
		{"relative root", CreateRequest{Name: "A", Root: "rel/dir"}, "full path"},
		{"bad kind", CreateRequest{Name: "A", Root: filepath.Join(parent, "n"), Kind: KindSandbox}, "Standard or Demo"},
		{"inside support dir", CreateRequest{Name: "A", Root: filepath.Join(global, "ws")}, "overlaps"},
		{"contains support dir", CreateRequest{Name: "A", Root: filepath.Dir(global)}, "overlaps"},
		{"inside tools", CreateRequest{Name: "A", Root: filepath.Join(tools, "x")}, "overlaps"},
		{"inside personal library", CreateRequest{Name: "A", Root: filepath.Join(lib, "x")}, "overlaps"},
		{"inside other workspace", CreateRequest{Name: "A", Root: filepath.Join(existing.Root, "Library", "x")}, "overlaps"},
		{"containing other workspace", CreateRequest{Name: "A", Root: parent}, "overlaps"},
		{"same as other workspace", CreateRequest{Name: "A", Root: existing.Root}, "workspace"},
		{"non-empty", CreateRequest{Name: "A", Root: nonEmpty}, "isn't empty"},
		{"baseline missing", CreateRequest{Name: "A", Root: filepath.Join(parent, "n"), Baseline: filepath.Join(parent, "nope")}, "starting folder"},
		{"baseline inside root", CreateRequest{Name: "A", Root: baseline + "x", Baseline: filepath.Join(baseline+"x", "sub")}, "starting folder"},
	}
	os.MkdirAll(filepath.Join(baseline+"x", "sub"), 0o755)
	os.Remove(filepath.Join(baseline+"x", "sub")) // keep root empty; the baseline then doesn't exist either
	for _, tt := range tests {
		err := st.Validate(tt.req, g)
		if tt.want == "" {
			if err != nil {
				t.Errorf("%s: unexpected %v", tt.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(strings.ToLower(core.AsAppError(err).Message), strings.ToLower(tt.want)) {
			t.Errorf("%s: err = %v, want %q", tt.name, err, tt.want)
		}
	}
	// the hint for a non-empty folder
	err = st.Validate(CreateRequest{Name: "A", Root: nonEmpty}, g)
	if ae := core.AsAppError(err); ae == nil || !strings.Contains(ae.Hint, "Pick an empty folder, or use Add existing") {
		t.Fatalf("hint: %v", err)
	}
}

func TestCreateWrites(t *testing.T) {
	global := env(t)
	st := Store{Dir: global}
	base := t.TempDir()
	info, err := st.Create(CreateRequest{Name: "Demo", Root: filepath.Join(t.TempDir(), "d"), Kind: KindDemo, Baseline: base, Present: true}, Guard{})
	if err != nil {
		t.Fatal(err)
	}
	if !info.StripLocation || !info.Present || len(info.Keep) != 2 || info.Created == 0 || len(info.ID) != 12 {
		t.Fatalf("info = %+v", info)
	}
	got, err := ReadInfo(info.Root)
	if err != nil || got.Name != "Demo" || got.Baseline != base || got.ID != info.ID {
		t.Fatalf("read back: %+v %v", got, err)
	}
	if st, err := os.Stat(filepath.Join(info.Root, "Library")); err != nil || !st.IsDir() {
		t.Fatal("no Library folder")
	}
	// boot says a seed is pending until the manifest exists
	if b, _ := Resolve([]string{ArgWorkspace, info.ID}); !b.SeedPending {
		t.Fatal("seed not pending")
	}
	if err := WriteManifest(info.Root, Manifest{}); err != nil {
		t.Fatal(err)
	}
	if b, _ := Resolve([]string{ArgWorkspace, info.ID}); b.SeedPending {
		t.Fatal("seed still pending")
	}
}

func TestRegistryRoundTripAndMutations(t *testing.T) {
	global := env(t)
	st := Store{Dir: global}
	a := mustCreate(t, st, "Alpha", KindStandard)
	b := mustCreate(t, st, "Beta", KindStandard)
	list, notice := st.List(a.ID)
	if notice != "" || len(list) != 3 || list[0].ID != PersonalID || !list[1].Current || list[2].Current {
		t.Fatalf("list = %+v (%q)", list, notice)
	}
	if err := st.Rename(a.ID, "beta"); err == nil {
		t.Fatal("duplicate rename accepted")
	}
	if err := st.Rename(PersonalID, "X"); err == nil {
		t.Fatal("renamed personal")
	}
	if err := st.Rename(a.ID, "Gamma"); err != nil {
		t.Fatal(err)
	}
	if in, _ := ReadInfo(a.Root); in.Name != "Gamma" {
		t.Fatalf("workspace.json name = %q", in.Name)
	}
	in, err := st.UpdateInfo(b.ID, func(i *Info) { i.Present = true })
	if err != nil || !in.Present {
		t.Fatal(err)
	}
	if err := st.Remove(PersonalID); err == nil {
		t.Fatal("removed personal")
	}
	if err := st.Remove(b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b.Root); err != nil {
		t.Fatal("Remove deleted files")
	}
	if l, _ := st.List(""); len(l) != 2 {
		t.Fatalf("after remove: %+v", l)
	}
}

func TestCorruptListKeepsBak(t *testing.T) {
	global := env(t)
	if err := os.WriteFile(filepath.Join(global, ListFile), []byte("{nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	if b.Info.ID != PersonalID || b.Notice == "" {
		t.Fatalf("boot = %+v", b)
	}
	bak, err := os.ReadFile(filepath.Join(global, ListFile+".bak"))
	if err != nil || string(bak) != "{nope" {
		t.Fatalf("bak = %q %v", bak, err)
	}
}

func TestMissingRootFallsBackToPersonal(t *testing.T) {
	global := env(t)
	st := Store{Dir: global}
	info := mustCreate(t, st, "Demo", KindDemo)
	if err := st.SetActive(info.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(info.Root); err != nil {
		t.Fatal(err)
	}
	b, _ := Resolve(nil)
	if b.Info.ID != PersonalID || !strings.Contains(b.Notice, "Demo's folder isn't there") {
		t.Fatalf("boot = %+v", b)
	}
	list, _ := st.List(PersonalID)
	if len(list) != 2 || !list[1].Missing || list[1].Name != "Demo" || list[1].Kind != KindDemo {
		t.Fatalf("list = %+v", list)
	}
	// a corrupt workspace.json counts as missing too
	os.MkdirAll(filepath.Join(info.Root, ".toolbox"), 0o755)
	os.WriteFile(filepath.Join(info.Root, ".toolbox", InfoFile), []byte("{"), 0o644)
	if list, _ = st.List(""); !list[1].Missing {
		t.Fatal("corrupt workspace.json not Missing")
	}
}

func TestAddExisting(t *testing.T) {
	global := env(t)
	st := Store{Dir: global}
	other := Store{Dir: t.TempDir()}
	info := mustCreate(t, other, "Away", KindStandard)

	if _, err := st.AddExisting(t.TempDir(), Guard{}); err == nil {
		t.Fatal("added a plain folder")
	}
	got, err := st.AddExisting(info.Root, Guard{})
	if err != nil || got.ID != info.ID {
		t.Fatalf("%+v %v", got, err)
	}
	again, err := st.AddExisting(info.Root, Guard{})
	if err != nil || again.ID != info.ID {
		t.Fatalf("second add: %+v %v", again, err)
	}
	if l, _ := st.List(""); len(l) != 2 {
		t.Fatalf("list = %+v", l)
	}
	// a copied folder with the same id gets a new one
	cp := filepath.Join(t.TempDir(), "copy")
	os.MkdirAll(filepath.Join(cp, ".toolbox"), 0o755)
	data, _ := os.ReadFile(filepath.Join(info.Root, ".toolbox", InfoFile))
	data = []byte(strings.Replace(string(data), `"name": "Away"`, `"name": "Copy"`, 1))
	os.WriteFile(filepath.Join(cp, ".toolbox", InfoFile), data, 0o644)
	got, err = st.AddExisting(cp, Guard{})
	if err != nil || got.ID == info.ID || got.Name != "Copy" {
		t.Fatalf("copy: %+v %v", got, err)
	}
}

func TestPresenter(t *testing.T) {
	win := Presenter{On: true, Root: `C:\Work\Demo`, Name: "Demo", Home: `C:\Users\Nick`}
	paths := []struct{ in, want string }{
		{`C:\Work\Demo`, "Demo"},
		{`C:\Work\Demo\Library\Stems\song (vocals).flac`, "Demo/Library/Stems/song (vocals).flac"},
		{`c:\work\demo\Library\a.png`, "Demo/Library/a.png"},
		{`C:/Work/Demo/Library/a.png`, "Demo/Library/a.png"},
		{`C:\Work\Demo\`, "Demo"},
		{`C:\Users\Nick\Documents\a.txt`, "~/Documents/a.txt"},
		{`c:\users\nick`, "~"},
		{`C:\Work\Demo2\a.png`, `C:\Work\Demo2\a.png`},
		{`C:\Users\Nicholas\a.txt`, `C:\Users\Nicholas\a.txt`},
		{`D:\other\a.txt`, `D:\other\a.txt`},
		{"", ""},
	}
	for _, tt := range paths {
		if got := win.Path(tt.in); got != tt.want {
			t.Errorf("Path(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	// the root wins over home when it is inside home
	nested := Presenter{On: true, Root: `C:\Users\Nick\ws`, Name: "WS", Home: `C:\Users\Nick`}
	if got := nested.Path(`C:\Users\Nick\ws\Library\a`); got != "WS/Library/a" {
		t.Errorf("nested = %q", got)
	}
	posix := Presenter{On: true, Root: "/Volumes/Work/Demo", Name: "Demo", Home: "/Users/nick"}
	if got := posix.Path("/Volumes/Work/Demo/Library/a.png"); got != "Demo/Library/a.png" {
		t.Errorf("posix = %q", got)
	}
	if got := posix.Path("/Users/nick/Desktop/x"); got != "~/Desktop/x" {
		t.Errorf("posix home = %q", got)
	}
	if got := (Presenter{Root: `C:\Work\Demo`, Name: "Demo"}).Path(`C:\Work\Demo\a`); got != `C:\Work\Demo\a` {
		t.Errorf("off = %q", got)
	}

	texts := []struct{ in, want string }{
		{`open C:\Work\Demo\Library\a.png failed`, `open Demo/Library/a.png failed`},
		{`"C:\Work\Demo\Library\a b.png"`, `"Demo/Library/a b.png"`},
		{`two C:\Work\Demo and c:\users\nick\x.txt`, `two Demo and ~/x.txt`},
		{`{"p":"C:\\Work\\Demo\\Library\\a.png"}`, `{"p":"Demo/Library/a.png"}`},
		{`C:/Work/Demo/Library/a.png: no such file`, `Demo/Library/a.png: no such file`},
		{`C:\Work\Demo2 stays`, `C:\Work\Demo2 stays`},
		{`nothing here`, `nothing here`},
	}
	for _, tt := range texts {
		if got := win.Text(tt.in); got != tt.want {
			t.Errorf("Text(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	if got := (Presenter{}).Text(`C:\Work\Demo`); got != `C:\Work\Demo` {
		t.Errorf("off text = %q", got)
	}
}

func TestWithArg(t *testing.T) {
	got := WithArg([]string{"a.png", ArgWorkspace, "x", "b.png", ArgWorkspace + "=y"}, "z")
	want := []string{"a.png", "b.png", ArgWorkspace, "z"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v", got)
	}
	if got := WithArg([]string{ArgWorkspace, "x"}, ""); len(got) != 0 {
		t.Fatalf("remove: %v", got)
	}
}

func TestToolsLock(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	ctx1, unlock, err := AcquireTools(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	// nested in the same flow: re-entrant
	if _, un2, err := AcquireTools(ctx1, dir); err != nil {
		t.Fatalf("nested lock: %v", err)
	} else {
		un2()
	}
	// an independent locker waits ~2 s, then errors
	start := time.Now()
	_, _, err = AcquireTools(ctx, dir)
	if err == nil || !core.IsCode(err, core.CodeConflict) || !strings.Contains(err.Error(), "Another Toolbox is changing the tools") {
		t.Fatalf("second locker err = %v", err)
	}
	if d := time.Since(start); d < ToolsLockWait-200*time.Millisecond {
		t.Fatalf("gave up after %v", d)
	}
	unlock()
	unlock() // idempotent
	_, un3, err := AcquireTools(ctx, dir)
	if err != nil {
		t.Fatalf("after unlock: %v", err)
	}
	un3()

	// a waiter gets the lock when it is released in time
	_, unlock, _ = AcquireTools(ctx, dir)
	done := make(chan error, 1)
	go func() {
		_, un, err := AcquireTools(ctx, dir)
		if err == nil {
			un()
		}
		done <- err
	}()
	time.Sleep(300 * time.Millisecond)
	unlock()
	if err := <-done; err != nil {
		t.Fatalf("waiter: %v", err)
	}
	// cancelled ctx stops the wait
	_, unlock, _ = AcquireTools(ctx, dir)
	defer unlock()
	cctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, _, err := AcquireTools(cctx, dir); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancelled wait: %v", err)
	}
	// "" takes no lock
	if _, un, err := AcquireTools(ctx, ""); err != nil {
		t.Fatal(err)
	} else {
		un()
	}
}
