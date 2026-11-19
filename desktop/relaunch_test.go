package desktop

import (
	"strings"
	"testing"

	"toolbox/core"
)

func TestRelaunchUnderDevDoesNothing(t *testing.T) {
	old := underDev
	underDev = func() bool { return true }
	defer func() { underDev = old }()
	quit := false
	err := Relaunch(func() { quit = true })
	if !core.IsCode(err, core.CodeValidation) || core.AsAppError(err).Message != "Restart the dev server to use the new folder" {
		t.Fatalf("err %v", err)
	}
	if quit {
		t.Error("quit called under dev")
	}
}

func TestRelaunchWithReplacesWorkspaceArg(t *testing.T) {
	got := LaunchArgs([]string{"a.png", "--workspace", "old", "b.png"}, []string{"--workspace", "new"})
	want := "a.png|b.png|--workspace|new"
	if strings.Join(got, "|") != want {
		t.Fatalf("got %v, want %s", got, want)
	}
	if got := LaunchArgs([]string{"x", "--workspace", "keep"}, nil); strings.Join(got, "|") != "x|--workspace|keep" {
		t.Fatalf("no extra: %v", got)
	}
}

func TestRelaunchWithUnderDev(t *testing.T) {
	old := underDev
	underDev = func() bool { return true }
	defer func() { underDev = old }()
	quit := false
	err := RelaunchWith([]string{"--workspace", `C:\ws\demo`}, func() { quit = true })
	ae := core.AsAppError(err)
	if ae == nil || !strings.Contains(ae.Message, `TOOLBOX_WORKSPACE=C:\ws\demo`) || quit {
		t.Fatalf("err %v quit %v", err, quit)
	}
}

func TestRelaunchCommandKeepsArgs(t *testing.T) {
	cmd := relaunchCommand(`C:\Program Files\Toolbox\toolbox.exe`, []string{"--flag", "a b"})
	if cmd == nil || cmd.SysProcAttr == nil {
		t.Fatal("no command")
	}
	joined := strings.Join(cmd.Args, " ") + " " + cmd.SysProcAttr.CmdLine
	for _, want := range []string{"toolbox.exe", "--flag", "a b"} {
		if !strings.Contains(joined, want) {
			t.Errorf("%q missing from %q", want, joined)
		}
	}
}
