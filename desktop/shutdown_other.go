//go:build !windows && !(darwin && cgo)

package desktop

// osShuttingDown: no shutdown signal on this platform (a cgo-less macOS build
// can't read the quit Apple event), so quitting during a real focus session
// goes through the friction path.
func osShuttingDown() bool { return false }
