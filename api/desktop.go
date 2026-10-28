package api

import "toolbox/core"

// DesktopShell is the part of desktop.Shell the UI calls.
type DesktopShell interface {
	HotkeyStatus() []core.HotkeyStatus
	HidePopup() error
	ShowMain(view string) error
	PastePermission() string
	RequestPastePermission() error
	PasteAfterCopy() error
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

// PastePermission reports whether auto-paste can send keystrokes:
// "granted", "denied" (macOS Accessibility not allowed) or "unsupported".
func (s *DesktopService) PastePermission() string {
	sh, err := s.shell()
	if err != nil {
		return "unsupported"
	}
	return sh.PastePermission()
}

// RequestPastePermission asks the OS for the permission auto-paste needs
// (macOS: the Accessibility prompt). No-op elsewhere.
func (s *DesktopService) RequestPastePermission() error {
	sh, err := s.shell()
	if err != nil {
		return err
	}
	return sh.RequestPastePermission()
}

// PasteAfterCopy hides the popup and, when auto-paste is enabled, pastes the
// just-copied item into the app that was focused before the popup opened.
// Without auto-paste (or permission) it only hides the popup.
func (s *DesktopService) PasteAfterCopy() error {
	sh, err := s.shell()
	if err != nil {
		return err
	}
	return sh.PasteAfterCopy()
}
