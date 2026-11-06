//go:build !windows

package desktop

// osShuttingDown: Wails exposes no shutdown signal on macOS, so a Cmd+Q
// during logout while a real focus session is on goes through the friction
// path (documented gap; macOS terminates the app after its quit timeout).
func osShuttingDown() bool { return false }
