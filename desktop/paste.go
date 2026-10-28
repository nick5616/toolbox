package desktop

import "context"

// Paste permission states (DesktopService.PastePermission).
const (
	PasteGranted     = "granted"
	PasteDenied      = "denied"
	PasteUnsupported = "unsupported"
)

// Paster restores focus to the app that was active before the popup opened
// and sends one paste chord (Phase 4 SPEC §13.2). Implemented per OS in
// paste_{windows,darwin,other}.go.
//
// CONTRACT STUB (foundation): WP-D2 implements the platform code and the
// Shell wiring (Remember before the popup shows; PasteAfterCopy).
type Paster interface {
	// Remember records the currently focused window/app (ignoring our own).
	Remember()
	// Paste re-activates the remembered window/app, waits for modifier keys
	// to be released, and sends Ctrl+V / Cmd+V once.
	Paste(ctx context.Context) error
	// Permission reports PasteGranted, PasteDenied or PasteUnsupported.
	Permission() string
	// RequestPermission prompts for the permission where the OS has one.
	RequestPermission() error
}

// PastePermission reports whether auto-paste can work here.
func (s *Shell) PastePermission() string { return PasteUnsupported }

// RequestPastePermission prompts for the auto-paste permission (macOS).
func (s *Shell) RequestPastePermission() error { return nil }

// PasteAfterCopy hides the popup and pastes into the previous app when
// auto-paste is enabled (WP-D2). The stub only hides the popup.
func (s *Shell) PasteAfterCopy() error { return s.HidePopup() }
