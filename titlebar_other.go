//go:build !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// setTitleBarDark is a no-op off Windows (macOS uses a hidden-inset title bar
// that follows the system appearance).
func setTitleBarDark(*application.WebviewWindow, bool) {}
