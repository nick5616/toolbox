package api

import "toolbox/core"

// DesktopShell is the part of desktop.Shell the UI calls.
type DesktopShell interface {
	HotkeyStatus() []core.HotkeyStatus
	HidePopup() error
	ShowMain(view string) error
}

// DesktopService exposes the desktop shell (tray, hotkeys, popup) to the UI.
// Shell is set after the Wails app is created.
type DesktopService struct {
	Shell DesktopShell
}

func (s *DesktopService) shell() (DesktopShell, error) {
	if s.Shell == nil {
		return nil, core.Errorf(core.CodeInternal, "The desktop shell isn't ready yet")
	}
	return s.Shell, nil
}

// HotkeyStatus returns whether each global hotkey is registered.
func (s *DesktopService) HotkeyStatus() []core.HotkeyStatus {
	sh, err := s.shell()
	if err != nil {
		return []core.HotkeyStatus{}
	}
	return sh.HotkeyStatus()
}

// HidePopup hides the popup window (after copying an item).
func (s *DesktopService) HidePopup() error {
	sh, err := s.shell()
	if err != nil {
		return err
	}
	return sh.HidePopup()
}

// ShowMain shows and focuses the main window, optionally navigating to view
// ("palette", "settings", "library" or a module ID).
func (s *DesktopService) ShowMain(view string) error {
	sh, err := s.shell()
	if err != nil {
		return err
	}
	return sh.ShowMain(view)
}
