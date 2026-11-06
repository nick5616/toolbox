package desktop

import "toolbox/core/focus"

// FocusEngine is what the shell needs from Focus Lock (Phase 18): the tray
// items, the quit gate and the focusStart hotkey. main.go passes the engine.
type FocusEngine interface {
	State() focus.State
	Subscribe(fn func(focus.State)) (unsubscribe func())
	Begin(req focus.StartRequest) (focus.Session, error)
	Settings() focus.Settings
	Profiles() ([]focus.Profile, error)
}

// ShouldQuit is Wails' Options.ShouldQuit (SPEC.md §2.4). Wave 0: always
// true; WP-S1 refuses while a real session is on and the quit isn't
// released, opening Focus on the quit dialog (never during OS shutdown).
func (s *Shell) ShouldQuit() bool { return true }
