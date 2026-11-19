package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestNoGlobalDirsOutsideWorkspace keeps app data inside the open workspace
// (Phase 21 SPEC §A6b): no non-test code reaches the user's global folders
// except the allowlisted read-only uses below. Anything a tool writes goes
// through core.Paths (support, tmp, cache, tools) or the library.
func TestNoGlobalDirsOutsideWorkspace(t *testing.T) {
	forbidden := regexp.MustCompile(`os\.(UserConfigDir|UserHomeDir|UserCacheDir|TempDir)\(|core\.DefaultLibraryDir\(|\bDefaultLibraryDir\(|Getenv\("(APPDATA|LOCALAPPDATA|USERPROFILE|HOME|TEMP|TMP|TMPDIR)"\)`)
	allow := map[string]string{
		"core/paths.go":            "resolves the global support dir and Personal's default library",
		"core/workspace/":          "resolves which workspace to open",
		"core/deps/detect.go":      "read-only: finds system-installed tools",
		"core/focus/policy.go":     "read-only: the OS's own folders",
		"modules/focus/apps.go":    "read-only: lists installed apps",
		"main.go":                  "boot: resolves the workspace and the Personal default library",
		"desktop/autostart.go":     "the OS login item",
		"workspace_isolation_test": "this test",
	}
	skipDir := map[string]bool{".git": true, ".dev": true, ".claude": true, "node_modules": true, "frontend": true, "sidecar": true, "bin": true, "build": true, "workspaces": true, "demoAssets": true, "demo": true}
	var bad []string
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skipDir[d.Name()] && path != "." {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel := filepath.ToSlash(path)
		for prefix := range allow {
			if strings.HasPrefix(rel, prefix) {
				return nil
			}
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(b), "\n") {
			if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "//") {
				continue
			}
			if forbidden.MatchString(line) {
				bad = append(bad, rel+":"+itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range bad {
		t.Errorf("reaches a global folder outside the workspace: %s", b)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
