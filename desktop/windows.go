package desktop

import (
	"slices"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"toolbox/core"
)

// Pop-out windows (Phase 10, SPEC.md §4): any tool or part in its own
// window. Windows are ordinary framed app windows loading the app's own
// page; nothing here listens on a socket.

// windowManager tracks the open pop-outs, their pending handoffs and the
// last bounds of each key (for this session).
type windowManager struct {
	s        *Shell
	mu       sync.Mutex
	open     map[string]*application.WebviewWindow
	handoffs map[string]string
	bounds   map[string]application.Rect
}

func newWindowManager(s *Shell) *windowManager {
	return &windowManager{s: s, open: map[string]*application.WebviewWindow{}, handoffs: map[string]string{}, bounds: map[string]application.Rect{}}
}

// windowsChangedLocked builds the windows:changed payload. Callers hold mu.
func (m *windowManager) keysLocked() []string {
	keys := make([]string, 0, len(m.open))
	for k := range m.open {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func (m *windowManager) emitChanged() {
	m.mu.Lock()
	keys := m.keysLocked()
	m.mu.Unlock()
	m.s.o.Emitter.Emit(core.EventWindowsChanged, core.WindowsChanged{Open: keys})
}

// popOut opens or focuses the window for req.Key.
func (m *windowManager) popOut(req core.PopOutRequest) error {
	req, err := core.NormalizePopOut(req)
	if err != nil {
		return err
	}
	m.mu.Lock()
	if w, ok := m.open[req.Key]; ok {
		if req.Handoff != "" {
			m.handoffs[req.Key] = req.Handoff
		}
		m.mu.Unlock()
		if w.IsMinimised() {
			w.UnMinimise()
		}
		w.Show()
		w.Focus()
		if req.Handoff != "" {
			m.s.o.Emitter.Emit(core.EventWindowsHandoff, core.WindowHandoff{Key: req.Key})
		}
		return nil
	}
	if len(m.open) >= core.MaxPopOuts {
		m.mu.Unlock()
		return core.Errorf(core.CodeValidation, "Too many windows are open").WithHint("Close a pop-out window first")
	}
	if req.Handoff != "" {
		m.handoffs[req.Key] = req.Handoff
	} else {
		delete(m.handoffs, req.Key)
	}
	b, hasBounds := m.bounds[req.Key]
	m.mu.Unlock()

	dark := m.s.o.DarkMode != nil && m.s.o.DarkMode()
	opts := application.WebviewWindowOptions{
		Name:             req.Key,
		Title:            req.Title,
		Width:            req.Width,
		Height:           req.Height,
		MinWidth:         480,
		MinHeight:        360,
		URL:              "/?" + req.Query + "&key=" + req.Key,
		EnableFileDrop:   true,
		BackgroundColour: windowBackground(dark),
		Windows:          application.WindowsWindow{Theme: windowTheme(dark)},
	}
	if hasBounds {
		opts.X, opts.Y, opts.Width, opts.Height = b.X, b.Y, b.Width, b.Height
		opts.InitialPosition = application.WindowXY
	}
	w := m.s.o.App.Window.NewWithOptions(opts)
	if m.s.o.OnNewWindow != nil {
		m.s.o.OnNewWindow(w)
	}
	key := req.Key
	w.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		m.mu.Lock()
		if cur, ok := m.open[key]; ok && cur == w {
			m.bounds[key] = w.Bounds()
			delete(m.open, key)
			delete(m.handoffs, key)
		}
		m.mu.Unlock()
		m.emitChanged()
	})
	w.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		if m.s.o.OnFilesDropped != nil {
			m.s.o.OnFilesDropped(key, e)
		}
	})
	m.mu.Lock()
	m.open[key] = w
	m.mu.Unlock()
	w.Show()
	w.Focus()
	m.emitChanged()
	return nil
}

// close closes the window for key (no-op if it isn't open).
func (m *windowManager) close(key string) error {
	m.mu.Lock()
	w, ok := m.open[key]
	m.mu.Unlock()
	if ok {
		w.Close()
	}
	return nil
}

// focus shows and focuses an open window; false if it isn't open.
func (m *windowManager) focus(key string) bool {
	m.mu.Lock()
	w, ok := m.open[key]
	m.mu.Unlock()
	if !ok {
		return false
	}
	if w.IsMinimised() {
		w.UnMinimise()
	}
	w.Show()
	w.Focus()
	return true
}

func (m *windowManager) list() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.keysLocked()
}

// takeHandoff returns and clears the pending handoff for key ("" = none).
func (m *windowManager) takeHandoff(key string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.handoffs[key]
	delete(m.handoffs, key)
	return h
}

func (m *windowManager) relay(r core.WindowRelay) error {
	if err := core.ValidateRelay(r); err != nil {
		return err
	}
	m.s.o.Emitter.Emit(core.EventWindowsRelay, r)
	return nil
}

func windowBackground(dark bool) application.RGBA {
	if dark {
		return application.NewRGB(11, 12, 14)
	}
	return application.NewRGB(247, 247, 249)
}

func windowTheme(dark bool) application.Theme {
	if dark {
		return application.Dark
	}
	return application.Light
}

// PopOut opens (or focuses) a pop-out window.
func (s *Shell) PopOut(req core.PopOutRequest) error { return s.windows.popOut(req) }

// CloseWindow closes a pop-out window.
func (s *Shell) CloseWindow(key string) error { return s.windows.close(key) }

// FocusWindow shows and focuses a pop-out window ("main" = the main window).
func (s *Shell) FocusWindow(key string) error {
	if key == "main" {
		return s.ShowMain("")
	}
	if !s.windows.focus(key) {
		return core.Errorf(core.CodeNotFound, "That window is closed")
	}
	return nil
}

// OpenWindows lists the open pop-out windows' keys.
func (s *Shell) OpenWindows() []string { return s.windows.list() }

// TakeHandoff returns and clears the handoff waiting for a window.
func (s *Shell) TakeHandoff(key string) string { return s.windows.takeHandoff(key) }

// Relay fans a message out to every window.
func (s *Shell) Relay(r core.WindowRelay) error { return s.windows.relay(r) }
