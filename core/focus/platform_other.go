//go:build !windows && !darwin

package focus

import "toolbox/core"

// NewPlatform: no Focus Lock backend on this OS.
func NewPlatform() Platform {
	return stubPlatform{reason: core.Errorf(CodeUnsupported, "Focus Lock works on Windows and macOS")}
}

// AskToClose isn't available on this OS.
func AskToClose(pid uint32, created int64, path string) error {
	return core.Errorf(CodeUnsupported, "Focus Lock works on Windows and macOS")
}
