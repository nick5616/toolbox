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
