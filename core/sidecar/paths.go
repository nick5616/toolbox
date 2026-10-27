package sidecar

import (
	"path/filepath"
	"runtime"

	"toolbox/core"
)

func pythonPath(p core.Paths) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(p.SidecarDir, ".venv", "Scripts", "python.exe")
	}
	return filepath.Join(p.SidecarDir, ".venv", "bin", "python")
}
