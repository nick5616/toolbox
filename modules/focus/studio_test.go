package focus

import (
	"strings"
	"testing"
)

func TestStudioProfileMatchesExeNamesAndDedupes(t *testing.T) {
	wt := appFromExe("", `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.20_x64__8wekyb3d8bbwe\WindowsTerminal.exe`)
	wt.Label = "WindowsTerminal" // how Running() labels it
	wt.Rule.Label = wt.Label
	claude := appFromExe("", `C:\Users\me\AppData\Local\AnthropicClaude\app-1.0\claude.exe`)
	claudeAgain := claude // the same program listed by both the Start menu and Running()
	claudeAgain.Label = "claude"
	p := studioProfile([]App{wt, claude, claudeAgain, {Label: "Steam", Path: `C:\Steam\steam.exe`}})
	var paths []string
	for _, r := range p.Rules {
		paths = append(paths, r.Path)
	}
	if len(p.Rules) != 2 {
		t.Fatalf("rules = %v", paths)
	}
	if !strings.Contains(p.Rules[0].Path, "AnthropicClaude") || !strings.Contains(p.Rules[1].Path, "WindowsTerminal_*") {
		t.Fatalf("rules = %v", paths)
	}
}

func TestMatchesPickSquashesSpaces(t *testing.T) {
	a := App{Label: "WindowsTerminal", Path: `C:\x\WindowsTerminal.exe`}
	if !matchesPick(a, "windows terminal") {
		t.Fatal("exe name without a space should match")
	}
	if matchesPick(App{Label: "Steam", Path: `C:\steam.exe`}, "windows terminal") {
		t.Fatal("false positive")
	}
}
