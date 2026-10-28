package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Environment overrides used by dev sandboxes and tests.
const (
	EnvSupportDir = "TOOLBOX_SUPPORT_DIR"
	EnvLibraryDir = "TOOLBOX_LIBRARY_DIR"
	EnvToolsDir   = "TOOLBOX_TOOLS_DIR"
)

// Tools folder files (SPEC.md §7.3).
const (
	// ToolsPointerFile in the support dir holds the tools folder's absolute path.
	ToolsPointerFile = "tools-location"
	// ToolsMarkerFile marks a folder as a tools folder.
	ToolsMarkerFile = ".toolbox-tools"
	// ToolsMoveCleanupFile in the support dir holds the old tools folder after a move.
	ToolsMoveCleanupFile = "tools-move-cleanup"
	// SetupPendingFile in the support dir holds packs to install after a relaunch.
	SetupPendingFile = "setup-pending.json"
)

// Paths are the app's own directories inside the support dir.
type Paths struct {
	SupportDir string
	BinDir     string
	TmpDir     string
	CacheDir   string
	LogDir     string
	LogFile    string
	DBPath     string
	// ToolsDir holds the heavy tool files (bin, python, sidecar, models).
	// It is the support dir unless moved (SPEC.md §7.3).
	ToolsDir        string
	ToolsDirFromEnv bool
	// Audio engine (Phase 2)
	SidecarDir string // installed Python project + .venv
	PythonDir  string // uv-managed CPython installs
	ModelsDir  string // downloaded ML models
	// Clipboard history images (Phase 3)
	ClipboardDir string
}

// NewPaths derives all paths from a support dir, with the tools folder
// inside it.
func NewPaths(supportDir string) Paths { return NewPathsWithTools(supportDir, supportDir) }

// NewPathsWithTools derives all paths from a support dir and a tools folder.
func NewPathsWithTools(supportDir, toolsDir string) Paths {
	return Paths{
		SupportDir: supportDir,
		ToolsDir:   toolsDir,
		BinDir:     filepath.Join(toolsDir, "bin"),
		TmpDir:     filepath.Join(supportDir, "tmp"),
		CacheDir:   filepath.Join(supportDir, "cache"),
		LogDir:     filepath.Join(supportDir, "logs"),
		LogFile:    filepath.Join(supportDir, "logs", "toolbox.log"),
		DBPath:     filepath.Join(supportDir, "toolbox.db"),
		SidecarDir: filepath.Join(toolsDir, "sidecar"),
		PythonDir:  filepath.Join(toolsDir, "python"),
		ModelsDir:  filepath.Join(toolsDir, "models"),

		ClipboardDir: filepath.Join(supportDir, "clipboard"),
	}
}

// ToolsDirs are the tools-folder subfolders a move copies.
func (p Paths) ToolsDirs() []string {
	return []string{p.BinDir, p.PythonDir, p.SidecarDir, p.ModelsDir}
}

// withTools applies $TOOLBOX_TOOLS_DIR or the pointer file to support-dir paths.
func withTools(supportDir string) (Paths, error) {
	if dir := os.Getenv(EnvToolsDir); dir != "" {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return Paths{}, fmt.Errorf("resolve %s: %w", EnvToolsDir, err)
		}
		p := NewPathsWithTools(supportDir, abs)
		p.ToolsDirFromEnv = true
		return p, nil
	}
	return NewPathsWithTools(supportDir, ReadToolsPointer(supportDir)), nil
}

// ReadToolsPointer returns the tools folder named by the pointer file, or
// supportDir when there is none (or it isn't an absolute path).
func ReadToolsPointer(supportDir string) string {
	b, err := os.ReadFile(filepath.Join(supportDir, ToolsPointerFile))
	if err != nil {
		return supportDir
	}
	dir := strings.TrimSpace(string(b))
	if dir == "" || !filepath.IsAbs(dir) {
		return supportDir
	}
	return filepath.Clean(dir)
}

// WriteToolsPointer records dir as the tools folder (atomically). Pointing at
// the support dir removes the pointer.
func WriteToolsPointer(supportDir, dir string) error {
	ptr := filepath.Join(supportDir, ToolsPointerFile)
	if filepath.Clean(dir) == filepath.Clean(supportDir) {
		if err := os.Remove(ptr); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove tools pointer: %w", err)
		}
		return nil
	}
	tmp := ptr + ".tmp"
	if err := os.WriteFile(tmp, []byte(filepath.Clean(dir)+"\n"), 0o644); err != nil {
		return fmt.Errorf("write tools pointer: %w", err)
	}
	if err := os.Rename(tmp, ptr); err != nil {
		return fmt.Errorf("write tools pointer: %w", err)
	}
	return nil
}

// ResolvePaths returns paths under $TOOLBOX_SUPPORT_DIR, or under
// os.UserConfigDir()/Toolbox (macOS: ~/Library/Application Support/Toolbox,
// Windows: %AppData%\Toolbox).
func ResolvePaths() (Paths, error) {
	if dir := os.Getenv(EnvSupportDir); dir != "" {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return Paths{}, fmt.Errorf("resolve %s: %w", EnvSupportDir, err)
		}
		return withTools(abs)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return Paths{}, fmt.Errorf("locate user config dir: %w", err)
	}
	return withTools(filepath.Join(base, "Toolbox"))
}

// Ensure creates all directories.
// A moved tools folder that doesn't exist (an unplugged drive) is left alone:
// the shell reports it instead (SPEC.md §7.3).
func (p Paths) Ensure() error {
	dirs := []string{p.SupportDir, p.TmpDir, p.CacheDir, p.LogDir}
	if p.ToolsAvailable() {
		dirs = append(dirs, p.BinDir, p.ModelsDir)
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", d, err)
		}
	}
	return nil
}

// ToolsAvailable reports whether the tools folder can be used: it is the
// support dir, or it exists.
func (p Paths) ToolsAvailable() bool {
	if p.ToolsDir == "" || filepath.Clean(p.ToolsDir) == filepath.Clean(p.SupportDir) {
		return true
	}
	fi, err := os.Stat(p.ToolsDir)
	return err == nil && fi.IsDir()
}

// DefaultLibraryDir is $TOOLBOX_LIBRARY_DIR or ~/Toolbox.
func DefaultLibraryDir() (string, error) {
	if dir := os.Getenv(EnvLibraryDir); dir != "" {
		return filepath.Abs(dir)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home dir: %w", err)
	}
	return filepath.Join(home, "Toolbox"), nil
}

// IsWithin reports whether path is parent or inside parent (after cleaning).
// Comparison is case-insensitive on Windows-style volume paths.
func IsWithin(path, parent string) bool {
	rel, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(path))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}
