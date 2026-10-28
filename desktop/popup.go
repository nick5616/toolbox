package desktop

import (
	"context"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
)

const (
	popupW = 440
	popupH = 560
)

func timeoutCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 3*time.Second)
}

// popupBackground returns the popup window colour for the theme.
func popupBackground(dark bool) application.RGBA {
	if dark {
		return application.NewRGB(19, 20, 23)
	}
	return application.NewRGB(247, 247, 249)
}

// popupPosition centres a w×h window horizontally in the work area and puts
// it in the upper third.
func popupPosition(wx, wy, ww, wh, w, h int) (x, y int) {
	x = wx + (ww-w)/2
	y = wy + (wh-h)/3
	if y < wy {
		y = wy
	}
	return x, y
}

type popup struct {
	s   *Shell
	win *application.WebviewWindow
	mu  sync.Mutex
}

func (p *popup) create() {
	dark := p.s.o.DarkMode != nil && p.s.o.DarkMode()
	p.win = p.s.o.App.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "popup",
		Title:            "Clipboard history",
		Width:            popupW,
		Height:           popupH,
		URL:              "/?window=popup&view=clipboard",
		Frameless:        true,
		AlwaysOnTop:      true,
		Hidden:           true,
		HideOnFocusLost:  true,
		HideOnEscape:     true,
		DisableResize:    true,
		BackgroundColour: popupBackground(dark),
		Windows:          application.WindowsWindow{HiddenOnTaskbar: true},
	})
	// Follow theme changes (the popup is hidden most of the time).
	p.s.o.Settings.OnChange(func(old, new core.Settings) {
		if old.Theme != new.Theme {
			p.applyTheme()
		}
	})
}

func (p *popup) applyTheme() {
	if p.win == nil || p.s.o.DarkMode == nil {
		return
	}
	p.win.SetBackgroundColour(popupBackground(p.s.o.DarkMode()))
}

func (p *popup) toggle() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.win == nil {
		return core.Errorf(core.CodeInternal, "The popup isn't ready yet")
	}
	if p.win.IsVisible() {
		p.win.Hide()
		return nil
	}
	// --- auto-paste (WP-D2)
	p.s.rememberForPaste() // before we take focus
	// --- end auto-paste ---
	p.applyTheme()
	if scr := p.s.o.App.Screen.GetPrimary(); scr != nil {
		wa := scr.WorkArea
		x, y := popupPosition(wa.X, wa.Y, wa.Width, wa.Height, popupW, popupH)
		p.win.SetPosition(x, y)
	}
	p.win.Show()
	p.win.Focus()
	p.s.o.Emitter.Emit(core.EventWindowShow, core.ShowView{View: "clipboard"})
	return nil
}

func (p *popup) hide() error {
	if p.win != nil {
		p.win.Hide()
	}
	return nil
}
