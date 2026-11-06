//go:build windows

package focus

import "toolbox/core"

// NewPlatform returns this OS's platform. Wave 0 stub; WP-F1 implements it
// (SPEC.md §1, §1.7).
func NewPlatform() Platform { return stubPlatform{reason: core.NotImplemented("Focus Lock")} }

// AskToClose politely closes a program Toolbox launched (Open in app's
// closeWhen): WM_CLOSE to its windows on Windows, the bundle's own quit on
// the Mac (path is the .app or its executable). Never terminates.
func AskToClose(pid uint32, created int64, path string) error {
	return core.NotImplemented("closing apps")
}
