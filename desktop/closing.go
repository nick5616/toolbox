package desktop

import "toolbox/core"

// closeActions are the side effects of a main-window close request.
type closeActions struct {
	cancel func() // veto the close
	hide   func()
	emit   func(name string, data any)
	quit   func()
}

// handleClose implements close-to-tray: with keepInTray the close is vetoed,
// the window hidden and app:hidden-to-tray emitted; otherwise the app quits.
func handleClose(keepInTray bool, a closeActions) {
	if !keepInTray {
		a.quit()
		return
	}
	a.cancel()
	a.hide()
	a.emit(core.EventHiddenToTray, core.HiddenToTray{})
}
