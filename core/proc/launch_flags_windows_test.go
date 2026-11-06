//go:build windows

package proc

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestLaunchFlagsConsoleExe(t *testing.T) {
	// The Go test binary is a console program.
	if !isConsoleExe(os.Args[0]) {
		t.Fatal("the test binary should be a console exe")
	}
	if f := launchFlags(os.Args[0]); f&windows.CREATE_NEW_CONSOLE == 0 || f&windows.CREATE_NEW_PROCESS_GROUP == 0 {
		t.Fatalf("flags for a console exe = %#x", f)
	}
	// explorer.exe is a window program.
	explorer := filepath.Join(os.Getenv("SystemRoot"), "explorer.exe")
	if _, err := os.Stat(explorer); err == nil {
		if isConsoleExe(explorer) {
			t.Fatal("explorer.exe reported as a console exe")
		}
		if f := launchFlags(explorer); f&windows.CREATE_NEW_CONSOLE != 0 {
			t.Fatalf("flags for a GUI exe = %#x", f)
		}
	}
	// Not a PE file: no console is forced.
	junk := filepath.Join(t.TempDir(), "x.exe")
	if err := os.WriteFile(junk, []byte("not a pe"), 0o644); err != nil {
		t.Fatal(err)
	}
	if isConsoleExe(junk) || isConsoleExe(filepath.Join(t.TempDir(), "missing.exe")) {
		t.Fatal("unreadable files must not count as console programs")
	}
}
