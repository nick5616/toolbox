package focus

import (
	"testing"

	"toolbox/core"
)

func TestWildcardFolderRules(t *testing.T) {
	setEnv(t)
	cases := []struct {
		path    string
		refused bool
	}{
		{`C:\*`, true},
		{`%ProgramFiles%\*`, true},
		{`%LOCALAPPDATA%\*`, true},
		{`C:\Program Files\*`, true},
		{`C:\Users\*`, true},
		{`C:\Users\*\AppData\Local\Programs`, true},
		{`C:\Apps\*`, true},
		{`C:\Pro*`, true},
		{`%ProgramFiles%\Di*`, true},
		{`%ProgramFiles%\WindowsApps\*`, true},
		{`%ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal_*`, false},
		{`%ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal*`, false},
		{`%ProgramFiles%\WindowsApps\Foo*`, true},
		{`C:\Apps\Foo*`, false},
		{`C:\Apps\Live 12*\bin`, false},
		{`C:\Apps\Live`, false},
	}
	for _, c := range cases {
		err := CheckRule(AllowRule{Label: "x", Kind: RuleFolder, Path: c.path})
		if c.refused {
			ae := core.AsAppError(err)
			if ae == nil || ae.Message != tooBroadMessage {
				t.Errorf("CheckRule(%q) = %v, want the broad-folder refusal", c.path, err)
			}
		} else if err != nil {
			t.Errorf("CheckRule(%q) = %v, want valid", c.path, err)
		}
		// program rules are unaffected by the folder check
		if e := CheckRule(AllowRule{Label: "x", Kind: RuleExe, Path: c.path + `\a.exe`}); e != nil && core.AsAppError(e).Message == tooBroadMessage {
			t.Errorf("exe rule %q refused as too broad", c.path)
		}
	}
}

func TestWildcardFolderRulesMac(t *testing.T) {
	old := style
	style = pathStyle{mac: true}
	defer func() { style = old }()
	t.Setenv("HOME", "/Users/me")
	for _, p := range []string{"/*", "/Applications/*", "~/*", "~/Applications/*", "/Users/*"} {
		err := CheckRule(AllowRule{Label: "x", Kind: RuleFolder, Path: p})
		if ae := core.AsAppError(err); ae == nil || ae.Message != tooBroadMessage {
			t.Errorf("CheckRule(%q) = %v", p, err)
		}
	}
	if err := CheckRule(AllowRule{Label: "x", Kind: RuleFolder, Path: "/Applications/Slack*.app"}); err != nil {
		t.Errorf("fixed part: %v", err)
	}
}
