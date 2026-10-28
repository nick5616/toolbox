package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestToolsPointer(t *testing.T) {
	sup := t.TempDir()
	if got := ReadToolsPointer(sup); got != sup {
		t.Fatalf("no pointer: %q", got)
	}
	tools := filepath.Join(t.TempDir(), "Toolbox Tools")
	if err := WriteToolsPointer(sup, tools); err != nil {
		t.Fatal(err)
	}
	if got := ReadToolsPointer(sup); got != tools {
		t.Fatalf("pointer = %q, want %q", got, tools)
	}
	p := NewPathsWithTools(sup, tools)
	if p.BinDir != filepath.Join(tools, "bin") || p.ModelsDir != filepath.Join(tools, "models") ||
		p.SidecarDir != filepath.Join(tools, "sidecar") || p.PythonDir != filepath.Join(tools, "python") {
		t.Fatalf("tools dirs not derived from the tools folder: %+v", p)
	}
	if p.DBPath != filepath.Join(sup, "toolbox.db") || p.TmpDir != filepath.Join(sup, "tmp") {
		t.Fatalf("support dirs moved: %+v", p)
	}
	if p.ToolsAvailable() {
		t.Fatal("missing tools folder reported available")
	}
	if err := p.Ensure(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tools); !os.IsNotExist(err) {
		t.Fatal("Ensure created a missing tools folder")
	}
	if err := WriteToolsPointer(sup, sup); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(sup, ToolsPointerFile)); !os.IsNotExist(err) {
		t.Fatal("pointing at the support dir should remove the pointer")
	}
	if err := os.WriteFile(filepath.Join(sup, ToolsPointerFile), []byte("relative/dir\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ReadToolsPointer(sup); got != sup {
		t.Fatalf("relative pointer accepted: %q", got)
	}
}

func TestResolvePathsToolsEnv(t *testing.T) {
	sup, tools := t.TempDir(), t.TempDir()
	t.Setenv(EnvSupportDir, sup)
	t.Setenv(EnvToolsDir, tools)
	p, err := ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	if p.ToolsDir != tools || !p.ToolsDirFromEnv || p.BinDir != filepath.Join(tools, "bin") {
		t.Fatalf("paths = %+v", p)
	}
	t.Setenv(EnvToolsDir, "")
	if err := WriteToolsPointer(sup, tools); err != nil {
		t.Fatal(err)
	}
	p, err = ResolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	if p.ToolsDir != tools || p.ToolsDirFromEnv {
		t.Fatalf("pointer not used: %+v", p)
	}
}
