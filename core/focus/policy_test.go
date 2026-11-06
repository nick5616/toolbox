package focus

import (
	"testing"

	"toolbox/core"
)

type seenRec struct {
	info ProcInfo
	v    Verdict
}

type fakeSeen map[uint32]seenRec

func (f fakeSeen) Lookup(pid uint32) (ProcInfo, Verdict, bool) {
	r, ok := f[pid]
	return r.info, r.v, ok
}

func setEnv(t *testing.T) {
	t.Helper()
	t.Setenv("ProgramFiles", `C:\Program Files`)
	t.Setenv("ProgramFiles(x86)", `C:\Program Files (x86)`)
	t.Setenv("ProgramData", `C:\ProgramData`)
	t.Setenv("SystemRoot", `C:\Windows`)
	t.Setenv("windir", `C:\Windows`)
	t.Setenv("SystemDrive", `C:`)
	t.Setenv("USERPROFILE", `C:\Users\me`)
	t.Setenv("APPDATA", `C:\Users\me\AppData\Roaming`)
	t.Setenv("LOCALAPPDATA", `C:\Users\me\AppData\Local`)
}

func basePolicy() *SessionPolicy {
	return &SessionPolicy{
		Self: ProcInfo{PID: 100, Created: 1000, Session: 1}, Session: 1, SystemRoot: `C:\Windows`,
		ToolboxPIDs: map[uint32]int64{100: 1000},
		Rules: []AllowRule{
			{ID: "live", Kind: RuleExe, Path: `C:\Apps\Live\live.exe`, Children: true},
			{ID: "code", Kind: RuleFolder, Path: `%LOCALAPPDATA%\Programs\Microsoft VS Code`, Children: true},
			{ID: "nokids", Kind: RuleExe, Path: `C:\Apps\Calc\calc.exe`, Children: false},
			{ID: "wt", Kind: RuleFolder, Path: `%ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal_*`, Children: true},
			{ID: "ver", Kind: RuleExe, Path: `C:\Apps\Tool*\tool.exe`, Children: true},
		},
	}
}

func mkProc(pid, ppid uint32, created int64, path string) ProcInfo {
	return ProcInfo{PID: pid, ParentPID: ppid, Created: created, Session: 1, Path: path}
}

func TestDecideTable(t *testing.T) {
	setEnv(t)
	vAllow := func(reason string, confer bool) Verdict { return Verdict{Allow: true, Confer: confer, Reason: reason} }
	explorer := mkProc(500, 1, 2000, `C:\Windows\explorer.exe`)
	code := mkProc(600, 500, 3000, `C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe`)
	ps := mkProc(601, 600, 3100, `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
	live := mkProc(700, 500, 4000, `C:\Apps\Live\live.exe`)
	exited := mkProc(710, 1, 4000, `C:\Users\me\AppData\Local\Discord\Update.exe`)

	cases := []struct {
		name string
		p    ProcInfo
		seen fakeSeen
		mut  func(*SessionPolicy)
		want Verdict
	}{
		{"other session ignored", ProcInfo{PID: 9, Session: 0, Path: `C:\Evil\x.exe`}, nil, nil, vAllow("other-session", false)},
		{"toolbox itself", mkProc(100, 1, 1000, `C:\Toolbox\toolbox.exe`), nil, nil, vAllow("toolbox", true)},
		{"toolbox descendant via map", mkProc(120, 100, 1500, `C:\Tools\ffmpeg.exe`), nil, nil, vAllow("toolbox", true)},
		{"toolbox descendant, parent gone", mkProc(121, 777, 1600, `C:\Tools\ffmpeg.exe`), nil, func(s *SessionPolicy) { s.ToolboxPIDs[777] = 1200 }, vAllow("toolbox", true)},
		{"parent PID reused after child", mkProc(122, 777, 1100, `C:\Tools\x.exe`), nil, func(s *SessionPolicy) { s.ToolboxPIDs[777] = 1200 }, Verdict{Reason: "blocked"}},
		{"launched exe rule", mkProc(130, 1, 5000, `C:\Games\game.exe`), nil, func(s *SessionPolicy) {
			s.Launched = []AllowRule{{ID: "l", Kind: RuleExe, Path: `C:\Games\game.exe`, Children: true}}
		}, vAllow("toolbox", true)},
		{"system folder allowed, doesn't confer", explorer, nil, nil, vAllow("windows", false)},
		{"system folder case-insensitive and \\\\?\\", mkProc(131, 1, 5000, `\\?\c:\WINDOWS\system32\cmd.exe`), nil, nil, vAllow("windows", false)},
		{"explorer -> steam blocked", mkProc(501, 500, 2500, `C:\Program Files (x86)\Steam\steam.exe`),
			fakeSeen{500: {explorer, vAllow("windows", false)}}, nil, Verdict{Reason: "blocked"}},
		{"extras: defender", mkProc(140, 1, 1, `C:\Program Files\Windows Defender\x\MpDefenderCoreService.exe`), nil, nil, vAllow("windows-extra", false)},
		{"extras: ink", mkProc(141, 1, 1, `C:\Program Files\Common Files\microsoft shared\ink\TabTip.exe`), nil, nil, vAllow("windows-extra", false)},
		{"extras: MicrosoftWindows package", mkProc(142, 1, 1, `C:\Program Files\WindowsApps\MicrosoftWindows.Client.CBS_1.0.0_x64__abc\x.exe`), nil, nil, vAllow("windows-extra", false)},
		{"extras: other WindowsApps blocked", mkProc(143, 1, 1, `C:\Program Files\WindowsApps\Foo.App_1.0_x64__abc\x.exe`), nil, nil, Verdict{Reason: "blocked"}},
		{"extras: webview2", mkProc(144, 1, 1, `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe`), nil, nil, vAllow("windows-extra", false)},
		{"exe rule", live, nil, nil, vAllow("rule:live", true)},
		{"exe rule is case-insensitive", mkProc(701, 1, 1, `c:\apps\LIVE\Live.EXE`), nil, nil, vAllow("rule:live", true)},
		{"exe rule needs the exact file", mkProc(702, 1, 1, `C:\Apps\Live\other.exe`), nil, nil, Verdict{Reason: "blocked"}},
		{"folder rule with %VARS%", code, nil, nil, vAllow("rule:code", true)},
		{"folder rule: deeper file", mkProc(603, 1, 1, `C:\Users\me\AppData\Local\Programs\Microsoft VS Code\resources\app\x.exe`), nil, nil, vAllow("rule:code", true)},
		{"folder rule: sibling folder not matched", mkProc(604, 1, 1, `C:\Users\me\AppData\Local\Programs\Microsoft VS Code Insiders\Code.exe`), nil, nil, Verdict{Reason: "blocked"}},
		{"star segment in folder rule", mkProc(605, 1, 1, `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.20_x64__8wekyb3d8bbwe\wt.exe`), nil, nil, vAllow("rule:wt", true)},
		{"star segment doesn't cross segments", mkProc(606, 1, 1, `C:\Program Files\WindowsApps\Microsoft.WindowsTerminalX\wt.exe`), nil, nil, Verdict{Reason: "blocked"}},
		{"star segment in exe rule", mkProc(607, 1, 1, `C:\Apps\Tool 2\tool.exe`), nil, nil, vAllow("rule:ver", true)},
		{"Code -> powershell (system, no confer) -> go", mkProc(602, 601, 3200, `C:\Go\bin\go.exe`),
			fakeSeen{601: {ps, vAllow("windows", false)}, 600: {code, vAllow("rule:code", true)}}, nil, vAllow("child:600", true)},
		{"allowed parent without children doesn't confer", mkProc(610, 611, 100, `C:\Other\x.exe`),
			fakeSeen{611: {mkProc(611, 1, 50, `C:\Apps\Calc\calc.exe`), vAllow("rule:nokids", false)}}, nil, Verdict{Reason: "blocked"}},
		{"squirrel launcher whose parent exited", mkProc(711, 710, 4500, `C:\Users\me\AppData\Local\Discord\app-1\Discord.exe`),
			fakeSeen{710: {exited, vAllow("rule:code", true)}}, nil, vAllow("child:710", true)},
		{"parent pid reused (created later than child)", mkProc(720, 600, 2000, `C:\Other\x.exe`),
			fakeSeen{600: {code, vAllow("rule:code", true)}}, nil, Verdict{Reason: "blocked"}},
		{"blocked ancestor stops the walk", mkProc(730, 731, 100, `C:\Other\x.exe`),
			fakeSeen{731: {mkProc(731, 600, 90, `C:\Bad\y.exe`), Verdict{Reason: "blocked"}}, 600: {code, vAllow("rule:code", true)}}, nil, Verdict{Reason: "blocked"}},
		{"own rule beats a blocked parent", mkProc(732, 731, 100, liveExe),
			fakeSeen{731: {mkProc(731, 1, 90, `C:\Bad\y.exe`), Verdict{Reason: "blocked"}}}, nil, vAllow("rule:live", true)},
		{"unknown path allowed", ProcInfo{PID: 750, ParentPID: 1, Created: 1, Session: 1}, nil, nil, vAllow("unknown", false)},
		{"unknown path, child of allowed", ProcInfo{PID: 751, ParentPID: 600, Created: 9000, Session: 1},
			fakeSeen{600: {code, vAllow("rule:code", true)}}, nil, vAllow("child:600", true)},
		{"everything else blocked", mkProc(760, 1, 1, `C:\Program Files\Discord\Discord.exe`), nil, nil, Verdict{Reason: "blocked"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := basePolicy()
			if tc.mut != nil {
				tc.mut(s)
			}
			var seen Ancestry
			if tc.seen != nil {
				seen = tc.seen
			}
			if got := Decide(tc.p, s, seen); got != tc.want {
				t.Fatalf("Decide = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestDecideMac(t *testing.T) {
	old := style
	style = pathStyle{mac: true}
	defer func() { style = old }()
	s := &SessionPolicy{Self: ProcInfo{PID: 5000, Session: 501}, Session: 501, SystemRoot: "/System",
		ToolboxPIDs: map[uint32]int64{},
		Rules:       []AllowRule{{ID: "live", Kind: RuleFolder, Path: "/Applications/Ableton Live 12 Suite.app", Children: true}}}
	cases := []struct {
		path  string
		allow bool
		why   string
	}{
		{"/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", true, "windows"},
		{"/usr/libexec/x", true, "windows"},
		{"/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live", true, "rule:live"},
		{"/applications/ableton live 12 suite.app/Contents/Helper", true, "rule:live"},
		{"/Applications/Slack.app/Contents/MacOS/Slack", false, "blocked"},
	}
	for _, c := range cases {
		got := Decide(ProcInfo{PID: 9, ParentPID: 1, Created: 5, Session: 501, Path: c.path}, s, nil)
		if got.Allow != c.allow || got.Reason != c.why {
			t.Errorf("%s: %+v", c.path, got)
		}
	}
	if len(WindowsExtras()) != 0 {
		t.Error("the Mac has no Windows extras")
	}
}

func TestCheckRuleAndBroadFolders(t *testing.T) {
	setEnv(t)
	ok := AllowRule{Label: "Live", Kind: RuleFolder, Path: `C:\Apps\Live`, Children: true}
	if err := CheckRule(ok); err != nil {
		t.Fatal(err)
	}
	broad := []string{
		`C:\`, `c:/`, `C:\Windows`, `%SystemRoot%`, `%windir%\`, `C:\Program Files`, `%ProgramFiles%`,
		`C:\Program Files (x86)\`, `%ProgramFiles(x86)%`, `C:\ProgramData`, `%ProgramData%`, `C:\Users\me`, `%USERPROFILE%`,
		`%APPDATA%`, `C:\Users\me\AppData\Roaming`, `%LOCALAPPDATA%`, `%LOCALAPPDATA%\Programs`,
		`C:\Users\me\AppData\Local\Programs`, `%ProgramFiles%\WindowsApps`, `C:\Program Files\WindowsApps\`,
		`%USERPROFILE%\Desktop`, `C:\Users\me\Downloads`, `C:\Users\me\Documents\`, `C:\Users`,
	}
	for _, p := range broad {
		if !BroadFolder(p) {
			t.Errorf("BroadFolder(%q) = false", p)
		}
		err := CheckRule(AllowRule{Label: "x", Kind: RuleFolder, Path: p})
		ae := core.AsAppError(err)
		if ae == nil || ae.Message != "That folder holds too many programs. Pick the app's own folder." {
			t.Errorf("CheckRule(%q) = %v", p, err)
		}
		// the same path as an exe rule is a different matter
		if e := CheckRule(AllowRule{Label: "x", Kind: RuleExe, Path: p + `\a.exe`}); e != nil {
			t.Errorf("exe rule under %q refused: %v", p, e)
		}
	}
	for _, p := range []string{`C:\Apps\Live`, `%LOCALAPPDATA%\Programs\Foo`, `C:\Program Files\Foo`, `%ProgramFiles%\Ableton\Live 12`} {
		if BroadFolder(p) {
			t.Errorf("BroadFolder(%q) = true", p)
		}
	}
	bad := []AllowRule{
		{Label: "", Kind: RuleExe, Path: `C:\a.exe`},
		{Label: string(make([]rune, 61)), Kind: RuleExe, Path: `C:\a.exe`},
		{Label: "x", Kind: "weird", Path: `C:\a.exe`},
		{Label: "x", Kind: RuleExe, Path: `a.exe`},
		{Label: "x", Kind: RuleExe, Path: ``},
		{Label: "x", Kind: RuleExe, Path: `C:\a*\b*\c.exe`},
		{Label: "x", Kind: RuleExe, Path: `C:\a<b>.exe`},
	}
	for i, r := range bad {
		if r.Label == "\x00" {
			continue
		}
		if err := CheckRule(r); err == nil {
			t.Errorf("bad rule %d accepted: %+v", i, r)
		}
	}
	if err := CheckRule(AllowRule{Label: "Terminal", Kind: RuleFolder, Path: `%ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal_*`}); err != nil {
		t.Errorf("one star: %v", err)
	}
}

func TestBroadFolderMac(t *testing.T) {
	old := style
	style = pathStyle{mac: true}
	defer func() { style = old }()
	t.Setenv("HOME", "/Users/me")
	for _, p := range []string{"/", "/Applications", "/Applications/", "/System", "/Users", "/Library"} {
		if !BroadFolder(p) {
			t.Errorf("BroadFolder(%q) = false", p)
		}
	}
	for _, p := range []string{"/Applications/Slack.app", "/Users/me/Apps/Foo.app"} {
		if BroadFolder(p) {
			t.Errorf("BroadFolder(%q) = true", p)
		}
	}
}
