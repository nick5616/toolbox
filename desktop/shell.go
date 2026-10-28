// Package desktop is the always-on app shell (Phase 3 SPEC.md §3.4): system
// tray, close-to-tray, start at login, global hotkeys and the popup window.
// Besides main.go and api/, it is the only package allowed to import Wails.
//
// FOUNDATION STUB: WP-D1 implements this package (and may add files, unexported
// types and tests). Exported names and signatures in this file are frozen.
package desktop

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
)

// Clipboard is what the tray needs from Clipboard History.
type Clipboard interface {
	State() core.ClipboardState
	Pause() error
	Resume() error
}

// Options wire the shell to the app. All fields are required except
// Clipboard.
type Options struct {
	App       *application.App
	Main      *application.WebviewWindow // the main window
	Settings  *core.SettingsService
	Jobs      *core.Jobs
	Outputs   core.OutputStore // "Recent outputs" tray submenu
	Emitter   core.Emitter
	Clipboard Clipboard
	// DarkMode reports whether the effective UI theme is dark (popup background).
	DarkMode func() bool
}

// Shell owns the tray, hotkeys, popup window and close-to-tray behaviour.
type Shell struct {
	o Options
}

// New builds the shell. Call Start before app.Run.
func New(o Options) *Shell { return &Shell{o: o} }

// Start creates the tray and the hidden popup window, installs the main
// window's close hook, reconciles start-at-login, registers hotkeys and
// subscribes to settings changes. Errors from individual hotkeys are
// reported via hotkeys:status, not returned.
func (s *Shell) Start() error { return nil }

// TogglePopup shows the clipboard popup (centred in the upper third of the
// primary screen, focused, window:show emitted) or hides it if visible.
func (s *Shell) TogglePopup() error { return nil }

// HidePopup hides the popup.
func (s *Shell) HidePopup() error { return nil }

// ShowMain shows, unminimises and focuses the main window, then navigates to
// view ("" = stay; "palette" opens the command palette; else a view/module ID).
func (s *Shell) ShowMain(view string) error { return nil }

// HotkeyStatus returns the last registration result for every action.
func (s *Shell) HotkeyStatus() []core.HotkeyStatus { return []core.HotkeyStatus{} }

// Quit stops everything and quits the app (tray "Quit Toolbox", Cmd+Q).
func (s *Shell) Quit() { s.o.App.Quit() }
