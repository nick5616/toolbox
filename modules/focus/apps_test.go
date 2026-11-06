package focus

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"toolbox/core/focus"
)

func broadFake(paths ...string) func(string) bool {
	return func(p string) bool {
		for _, b := range paths {
			if strings.EqualFold(p, b) {
				return true
			}
		}
		return false
	}
}

func TestSuggestRule(t *testing.T) {
	broad := broadFake(`C:\Program Files`, `C:\Program Files (x86)`, `C:\Users\me\AppData\Local\Programs`, `C:\Users\me\AppData\Local`)
	tests := []struct {
		name, exe, kind, path string
	}{
		{"plain", `C:\Program Files\Ableton\Live 12\Program\Ableton Live 12 Suite.exe`, focus.RuleFolder, `C:\Program Files\Ableton\Live 12`},
		{"own folder", `C:\Program Files\Foo\foo.exe`, focus.RuleFolder, `C:\Program Files\Foo`},
		{"bin goes up", `C:\Program Files\Go\bin\go.exe`, focus.RuleFolder, `C:\Program Files\Go`},
		{"current goes up", `C:\Tools\Thing\current\thing.exe`, focus.RuleFolder, `C:\Tools\Thing`},
		{"version goes up", `C:\Tools\Thing\2.14.1\thing.exe`, focus.RuleFolder, `C:\Tools\Thing`},
		{"squirrel", `C:\Users\me\AppData\Local\Discord\app-1.0.9163\Discord.exe`, focus.RuleFolder, `C:\Users\me\AppData\Local\Discord`},
		{"squirrel with suffix", `C:\Users\me\AppData\Local\slack\app-4.39.95-beta\slack.exe`, focus.RuleFolder, `C:\Users\me\AppData\Local\slack`},
		{"only one level up", `C:\Apps\X\bin\bin\x.exe`, focus.RuleFolder, `C:\Apps\X\bin`},
		{"vscode", `C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe`, focus.RuleFolder, `C:\Users\me\AppData\Local\Programs\Microsoft VS Code`},
		{"broad root falls back to exe", `C:\Program Files\tool.exe`, focus.RuleExe, `C:\Program Files\tool.exe`},
		{"bin under broad folder", `C:\Program Files\bin\tool.exe`, focus.RuleExe, `C:\Program Files\bin\tool.exe`},
		{"programs folder", `C:\Users\me\AppData\Local\Programs\bin\p.exe`, focus.RuleExe, `C:\Users\me\AppData\Local\Programs\bin\p.exe`},
		{"drive root", `C:\tool.exe`, focus.RuleExe, `C:\tool.exe`},
		{"one below drive", `C:\bin\tool.exe`, focus.RuleExe, `C:\bin\tool.exe`},
		{"store app", `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.21.2361.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe`, focus.RuleFolder, `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_*`},
		{"forward slashes", `C:/Program Files/Foo/foo.exe`, focus.RuleFolder, `C:\Program Files\Foo`},
		{"mac bundle", `/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live`, focus.RuleFolder, `/Applications/Ableton Live 12 Suite.app`},
		{"mac bundle path", `/Applications/Slack.app`, focus.RuleFolder, `/Applications/Slack.app`},
		{"mac plain binary", `/usr/local/bin/thing`, focus.RuleExe, `/usr/local/bin/thing`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := suggestRule(tc.exe, broad)
			if r.Kind != tc.kind || r.Path != tc.path {
				t.Errorf("got %s %q, want %s %q", r.Kind, r.Path, tc.kind, tc.path)
			}
			if !r.Children || r.ID == "" || r.Label == "" || len([]rune(r.Label)) > focus.MaxRuleLabel {
				t.Errorf("rule = %+v", r)
			}
		})
	}
	if r := suggestRule(`C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.2_x64__x\wt.exe`, broad); r.Label != "Microsoft.WindowsTerminal" {
		t.Errorf("store label = %q", r.Label)
	}
}

func TestStoreFlag(t *testing.T) {
	a := appFromExe("Terminal", `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.21_x64__8w\wt.exe`)
	if !a.Store || a.Label != "Terminal" || a.Rule.Label != "Terminal" {
		t.Errorf("app = %+v", a)
	}
	if appFromExe("x", `C:\Program Files\Foo\foo.exe`).Store {
		t.Error("not a Store app")
	}
}

// writeShortcut writes a .lnk with the given target and an empty .exe there.
func writeShortcut(t *testing.T, dir, name, target string, create bool) {
	t.Helper()
	if create {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte("MZ"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	base, suffix := filepath.Dir(target), filepath.Base(target)
	data := lnkBuilder{idList: true, linkInfo: true, base: base, suffix: suffix}.build()
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanStartMenu(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("shortcut targets are Windows paths")
	}
	root := t.TempDir()
	menuA := filepath.Join(root, "ProgramData", "Programs")
	menuB := filepath.Join(root, "Roaming", "Programs")
	apps := filepath.Join(root, "Apps")

	writeShortcut(t, menuA, "Zeta.lnk", filepath.Join(apps, "Zeta", "zeta.exe"), true)
	writeShortcut(t, filepath.Join(menuA, "Folder", "Deep"), "Alpha.lnk", filepath.Join(apps, "Alpha", "bin", "alpha.exe"), true)
	writeShortcut(t, menuB, "Alpha again.lnk", filepath.Join(apps, "Alpha", "bin", "alpha.exe"), false) // same target: once
	writeShortcut(t, menuA, "Uninstall Zeta.lnk", filepath.Join(apps, "Zeta", "unins000.exe"), true)
	writeShortcut(t, menuA, "Missing.lnk", filepath.Join(apps, "Gone", "gone.exe"), false)
	writeShortcut(t, menuA, "Readme.lnk", filepath.Join(apps, "Zeta", "readme.txt"), true)
	if err := os.WriteFile(filepath.Join(menuA, "junk.lnk"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := scanStartMenu([]string{menuA, menuB, filepath.Join(root, "absent")})
	if len(got) != 2 {
		t.Fatalf("apps = %+v", got)
	}
	if got[0].Label != "Alpha" || got[1].Label != "Zeta" {
		t.Errorf("labels/order: %q %q", got[0].Label, got[1].Label)
	}
	if got[0].Rule.Kind != focus.RuleFolder || got[0].Rule.Path != filepath.Join(apps, "Alpha") {
		t.Errorf("Alpha rule = %+v", got[0].Rule)
	}
	if got[0].Rule.Label != "Alpha" {
		t.Errorf("rule label = %q", got[0].Rule.Label)
	}
}

func TestAppsCache(t *testing.T) {
	s := NewService(newFake(t0))
	now := t0
	s.clock = func() time.Time { return now }
	scans := 0
	s.scan = func() []App { scans++; return []App{{Label: "A"}} }
	for i := 0; i < 3; i++ {
		if a, err := s.Apps(); err != nil || len(a) != 1 {
			t.Fatalf("apps=%v err=%v", a, err)
		}
	}
	if scans != 1 {
		t.Errorf("scans = %d, want 1", scans)
	}
	now = now.Add(11 * time.Minute)
	_, _ = s.Apps()
	if scans != 2 {
		t.Errorf("scans = %d after the TTL, want 2", scans)
	}
	s.scan = func() []App { return nil }
	now = now.Add(time.Hour)
	if a, _ := s.Apps(); a == nil {
		t.Error("Apps must never be nil")
	}
}

// fakePlatform lists a fixed process table.
type fakePlatform struct {
	procs   []focus.ProcInfo
	windows map[uint32]bool
	self    focus.ProcInfo
	root    string
	paths   map[uint32]string
	err     error
}

func (f *fakePlatform) Snapshot(context.Context) ([]focus.ProcInfo, error) { return f.procs, nil }
func (f *fakePlatform) Terminate(focus.ProcInfo) error                     { panic("Terminate called") }
func (f *fakePlatform) AskToClose(focus.ProcInfo) (bool, error)            { panic("AskToClose called") }
func (f *fakePlatform) Paths(ps []focus.ProcInfo) {
	for i := range ps {
		ps[i].Path = f.paths[ps[i].PID]
	}
}
func (f *fakePlatform) Windows() map[uint32]bool              { return f.windows }
func (f *fakePlatform) Self() focus.ProcInfo                  { return f.self }
func (f *fakePlatform) InteractiveSession() uint32            { return f.self.Session }
func (f *fakePlatform) SystemRoot() string                    { return f.root }
func (f *fakePlatform) Supported() error                      { return f.err }
func (f *fakePlatform) Kicks(context.Context) <-chan struct{} { return nil }

func TestRunning(t *testing.T) {
	p := func(pid, ppid uint32, session uint32, name string) focus.ProcInfo {
		return focus.ProcInfo{PID: pid, ParentPID: ppid, Created: int64(pid), Session: session, Name: name}
	}
	fp := &fakePlatform{
		self: p(10, 1, 1, "toolbox.exe"),
		root: `C:\Windows`,
		procs: []focus.ProcInfo{
			p(10, 1, 1, "toolbox.exe"),
			p(11, 10, 1, "msedgewebview2.exe"), // Toolbox's child
			p(12, 11, 1, "grandchild.exe"),     // and its descendant
			p(20, 1, 1, "Discord.exe"),
			p(21, 1, 1, "Discord.exe"),    // same path: once
			p(22, 1, 1, "notepad.exe"),    // OS folder
			p(23, 1, 0, "service.exe"),    // another session
			p(24, 1, 1, "background.exe"), // no window
			p(25, 1, 1, "wt.exe"),
			p(26, 1, 1, "nopath.exe"), // access denied
		},
		windows: map[uint32]bool{10: true, 11: true, 12: true, 20: true, 21: true, 22: true, 23: true, 25: true, 26: true},
		paths: map[uint32]string{
			10: `C:\Toolbox\toolbox.exe`, 11: `C:\Toolbox\wv.exe`, 12: `C:\Toolbox\g.exe`,
			20: `C:\Users\me\AppData\Local\Discord\app-1.0.9\Discord.exe`,
			21: `C:\Users\me\AppData\Local\Discord\app-1.0.9\Discord.exe`,
			22: `C:\Windows\System32\notepad.exe`,
			23: `C:\svc\service.exe`,
			24: `C:\bg\background.exe`,
			25: `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.21_x64__8w\wt.exe`,
		},
	}
	s := NewService(newFake(t0))
	s.platform = fp
	got, err := s.Running()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("running = %+v", got)
	}
	if got[0].Label != "Discord" || got[0].Rule.Path != `C:\Users\me\AppData\Local\Discord` {
		t.Errorf("discord = %+v", got[0])
	}
	if got[1].Label != "wt" || !got[1].Store || got[1].Rule.Path != `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_*` {
		t.Errorf("terminal = %+v", got[1])
	}

	fp.err = focus.ErrGone // any error = unsupported
	if got, err := s.Running(); err != nil || len(got) != 0 {
		t.Errorf("unsupported: %v %v", got, err)
	}
}

func TestStudioProfile(t *testing.T) {
	mk := func(label string) App {
		return App{Label: label, Rule: focus.AllowRule{Label: label, Kind: focus.RuleExe, Path: `C:\` + label + `.exe`}}
	}
	p := studioProfile([]App{mk("Steam"), mk("Visual Studio Code"), mk("Discord"), mk("Discord PTB"), mk("Ableton Live 12 Suite")})
	var labels []string
	for _, r := range p.Rules {
		labels = append(labels, r.Label)
	}
	want := []string{"Discord", "Visual Studio Code", "Ableton Live 12 Suite"}
	if p.Name != "Studio" || strings.Join(labels, "|") != strings.Join(want, "|") {
		t.Errorf("profile = %+v", p)
	}
	if e := studioProfile(nil); len(e.Rules) != 0 || e.Rules == nil {
		t.Errorf("empty = %+v", e)
	}
}

func TestAppIconCache(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "a.exe")
	if err := os.WriteFile(exe, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(dir, "cache")
	renders := 0
	s := NewService(newFake(t0))
	s.iconFn = func(string) ([]byte, error) { renders++; return []byte("\x89PNG-fake"), nil }
	s.SetCacheDir(cache)

	first := s.AppIcon(exe)
	if !strings.HasPrefix(first, "data:image/png;base64,") {
		t.Fatalf("icon = %q", first)
	}
	if s.AppIcon(exe) != first || renders != 1 {
		t.Errorf("memory cache: renders = %d", renders)
	}
	// A new service reads the disk cache.
	s2 := NewService(newFake(t0))
	s2.iconFn = s.iconFn
	s2.SetCacheDir(cache)
	if s2.AppIcon(exe) != first || renders != 1 {
		t.Errorf("disk cache: renders = %d", renders)
	}
	// A changed file (mtime) re-renders.
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(exe, later, later); err != nil {
		t.Fatal(err)
	}
	s2.AppIcon(exe)
	if renders != 2 {
		t.Errorf("mtime change: renders = %d", renders)
	}
	if s.AppIcon(filepath.Join(dir, "missing.exe")) != "" || s.AppIcon("") != "" {
		t.Error("missing files have no icon")
	}
	// Failure gives "".
	s3 := NewService(newFake(t0))
	s3.iconFn = func(string) ([]byte, error) { return nil, os.ErrNotExist }
	if s3.AppIcon(exe) != "" {
		t.Error("failed render must give an empty string")
	}
}

func TestSetCacheDirPrunesOldIcons(t *testing.T) {
	dir := t.TempDir()
	old, fresh := filepath.Join(dir, "old.png"), filepath.Join(dir, "fresh.png")
	for _, p := range []string{old, fresh} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-40 * 24 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	NewService(newFake(t0)).SetCacheDir(dir)
	if _, err := os.Stat(old); err == nil {
		t.Error("old icon kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("fresh icon removed")
	}
}

func TestAppIconWindowsReal(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	if os.Getenv("TOOLBOX_FOCUS_E2E") != "1" {
		t.Skip("set TOOLBOX_FOCUS_E2E=1")
	}
	exe := filepath.Join(os.Getenv("SystemRoot"), "System32", "notepad.exe")
	if got := NewService(newFake(t0)).AppIcon(exe); !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Errorf("no icon for %s", exe)
	}
}

// TestRealStartMenuSweep is read-only: it resolves this machine's Start-menu
// shortcuts and checks the results are sane.
func TestRealStartMenuSweep(t *testing.T) {
	if os.Getenv("TOOLBOX_FOCUS_E2E") != "1" {
		t.Skip("set TOOLBOX_FOCUS_E2E=1")
	}
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	apps := scanApps()
	if len(apps) < 3 {
		t.Fatalf("only %d apps found", len(apps))
	}
	for _, a := range apps {
		if _, err := os.Stat(a.Path); err != nil {
			t.Errorf("%s: target missing: %v", a.Label, err)
		}
		if !strings.EqualFold(filepath.Ext(a.Path), ".exe") {
			t.Errorf("%s: not an exe: %s", a.Label, a.Path)
		}
		if a.Rule.Path == "" || a.Rule.Label == "" {
			t.Errorf("%s: empty rule %+v", a.Label, a.Rule)
		}
	}
	t.Logf("%d apps; first: %s -> %s (%s %s)", len(apps), apps[0].Label, apps[0].Path, apps[0].Rule.Kind, apps[0].Rule.Path)
}
