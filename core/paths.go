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
	// Audio engine (Phase 2)
	SidecarDir string // installed Python project + .venv
	PythonDir  string // uv-managed CPython installs
	ModelsDir  string // downloaded ML models
}

// NewPaths derives all paths from a support dir.
func NewPaths(supportDir string) Paths {
	return Paths{
		SupportDir: supportDir,
		BinDir:     filepath.Join(supportDir, "bin"),
		TmpDir:     filepath.Join(supportDir, "tmp"),
		CacheDir:   filepath.Join(supportDir, "cache"),
		LogDir:     filepath.Join(supportDir, "logs"),
		LogFile:    filepath.Join(supportDir, "logs", "toolbox.log"),
		DBPath:     filepath.Join(supportDir, "toolbox.db"),
		SidecarDir: filepath.Join(supportDir, "sidecar"),
		PythonDir:  filepath.Join(supportDir, "python"),
		ModelsDir:  filepath.Join(supportDir, "models"),
	}
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
		return NewPaths(abs), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return Paths{}, fmt.Errorf("locate user config dir: %w", err)
	}
	return NewPaths(filepath.Join(base, "Toolbox")), nil
}

// Ensure creates all directories.
func (p Paths) Ensure() error {
	for _, d := range []string{p.SupportDir, p.BinDir, p.TmpDir, p.CacheDir, p.LogDir, p.ModelsDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", d, err)
		}
	}
	return nil
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
