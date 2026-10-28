package desktop

import (
	"context"
	"log/slog"
	"time"

	"toolbox/desktop/paste"
)

// Paste permission states (DesktopService.PastePermission).
const (
	PasteGranted     = paste.Granted
	PasteDenied      = paste.Denied
	PasteUnsupported = paste.Unsupported
)

// Paster restores focus to the app that was active before the popup opened
// and sends one paste chord (Phase 4 SPEC §13.2). Implemented per OS in
// desktop/paste.
type Paster = paste.Paster

// pasteTimeout bounds one paste attempt (modifier wait ≤ 1 s + settle).
const pasteTimeout = 3 * time.Second

// rememberForPaste records the focused window just before the popup shows.
func (s *Shell) rememberForPaste() {
	if s.paster != nil {
		s.paster.Remember()
	}
}

// PastePermission reports whether auto-paste can work here.
func (s *Shell) PastePermission() string {
	if s.paster == nil {
		return PasteUnsupported
	}
	return s.paster.Permission()
}

// RequestPastePermission prompts for the auto-paste permission (macOS).
func (s *Shell) RequestPastePermission() error {
	if s.paster == nil {
		return nil
	}
	return s.paster.RequestPermission()
}

// PasteAfterCopy hides the popup and, when auto-paste is enabled and
// permitted, pastes into the previously focused app. The paste runs in the
// background so this returns promptly; failures are logged, never returned.
func (s *Shell) PasteAfterCopy() error {
	err := s.HidePopup()
	if s.paster == nil || s.o.Settings == nil || !s.o.Settings.Current().Clipboard.AutoPaste {
		return err
	}
	if s.paster.Permission() != PasteGranted {
		return err
	}
	s.pasteAsync(func() {
		ctx, cancel := context.WithTimeout(context.Background(), pasteTimeout)
		defer cancel()
		if perr := s.paster.Paste(ctx); perr != nil {
			slog.Warn("auto-paste skipped", "err", perr)
		}
	})
	return err
}
