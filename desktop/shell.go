// Package desktop is the always-on app shell (Phase 3 SPEC.md §3.4): system
// tray, close-to-tray, start at login, global hotkeys and the popup window.
// Besides main.go and api/, it is the only package allowed to import Wails.
package desktop

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"toolbox/core"
	"toolbox/desktop/paste"
)

// Clipboard is what the tray needs from Clipboard History.
type Clipboard interface {
	State() core.ClipboardState
	Pause() error
	Resume() error
}

// --- vault (VA1) ---

// VaultLocker is the slice of the vault the tray needs (vault.Service fits).
type VaultLocker interface {
	State() core.VaultState
	Lock() error
}

// --- end vault ---

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
	// --- vault (VA1) ---
	// Vault is optional; the tray shows "Lock vault" while it is unlocked.
	Vault VaultLocker
	// --- end vault ---
	// DarkMode reports whether the effective UI theme is dark (popup background).
	DarkMode func() bool
}

// Shell owns the tray, hotkeys, popup window and close-to-tray behaviour.
type Shell struct {
	o     Options
	hk    *hotkeyManager
	popup *popup
	tray  *tray
	login loginItem
	// --- auto-paste (WP-D2)
	paster     Paster
	pasteAsync func(func()) // runs the paste off the UI call; tests run it inline
	// --- end auto-paste ---
}

// New builds the shell. Call Start before app.Run.
func New(o Options) *Shell {
	s := &Shell{o: o}
	// --- auto-paste (WP-D2)
	s.paster = paste.New()
	s.pasteAsync = func(f func()) { go f() }
	// --- end auto-paste ---
	s.popup = &popup{s: s}
	s.tray = newTray(s)
	return s
}

// wailsRegistrar adapts app.GlobalShortcut to registrar.
type wailsRegistrar struct {
	m *application.GlobalShortcutManager
}

func (w wailsRegistrar) Register(a string, cb func()) error { return w.m.Register(a, cb) }
func (w wailsRegistrar) Unregister(a string) error          { return w.m.Unregister(a) }

// Start creates the tray and the hidden popup window, installs the main
// window's close hook, reconciles start-at-login, registers hotkeys and
// subscribes to settings changes. Errors from individual hotkeys are
// reported via hotkeys:status, not returned.
func (s *Shell) Start() error {
	o := s.o

	// Start at login: abortable before-change hook + startup reconcile.
	s.login = loginItem{a: o.App.Autostart}
	o.Settings.BeforeChange(s.login.beforeChange)
	s.login.reconcile(o.Settings.Current().StartAtLogin)

	// Close to tray.
	o.Main.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		handleClose(o.Settings.Current().KeepInTray, closeActions{
			cancel: e.Cancel,
			hide:   func() { o.Main.Hide() },
			emit:   o.Emitter.Emit,
			quit:   s.Quit,
		})
	})

	s.popup.create()

	// Hotkeys. Callbacks may arrive on any thread; the window calls used
	// below marshal to the UI thread themselves (InvokeSync inside Wails).
	s.hk = newHotkeyManager(wailsRegistrar{o.App.GlobalShortcut}, o.Emitter, map[string]func(){
		core.HotkeyClipboard: func() { _ = s.TogglePopup() },
		core.HotkeyQuickOpen: func() { _ = s.ShowMain("palette") },
	})
	s.hk.Apply(o.Settings.Current().Hotkeys)
	o.Settings.OnChange(func(old, new core.Settings) {
		if !sameHotkeys(old.Hotkeys, new.Hotkeys) {
			s.hk.Apply(new.Hotkeys)
		}
	})

	s.tray.start()
	return nil
}

func sameHotkeys(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// TogglePopup shows the clipboard popup (centred in the upper third of the
// primary screen, focused, window:show emitted) or hides it if visible.
func (s *Shell) TogglePopup() error { return s.popup.toggle() }

// HidePopup hides the popup.
func (s *Shell) HidePopup() error { return s.popup.hide() }

// ShowMain shows, unminimises and focuses the main window, then navigates to
// view ("" = stay; "palette" opens the command palette; else a view/module ID).
func (s *Shell) ShowMain(view string) error {
	w := s.o.Main
	w.Show()
	w.UnMinimise()
	w.Focus()
	if view != "" {
		s.o.Emitter.Emit(core.EventNavigate, core.Navigate{Target: view})
	}
	return nil
}

// HotkeyStatus returns the last registration result for every action.
func (s *Shell) HotkeyStatus() []core.HotkeyStatus {
	if s.hk == nil {
		return []core.HotkeyStatus{}
	}
	return s.hk.Status()
}

// Quit stops everything and quits the app (tray "Quit Toolbox", Cmd+Q).
func (s *Shell) Quit() { s.o.App.Quit() }
