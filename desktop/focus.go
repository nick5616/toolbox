package desktop

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"toolbox/core/focus"
)

// FocusEngine is what the shell needs from Focus Lock (Phase 18): the tray
// items, the quit gate and the focusStart hotkey. main.go passes the engine.
type FocusEngine interface {
	State() focus.State
	Subscribe(fn func(focus.State)) (unsubscribe func())
	Begin(req focus.StartRequest) (focus.Session, error)
	Settings() focus.Settings
	Profiles() ([]focus.Profile, error)
	RequestWeaken(a focus.Weaken, rule *focus.AllowRule) (focus.Friction, error)
}

// NavigateFocus is the navigate target of the Focus tool.
const NavigateFocus = "focus"

// realSession reports whether a non-dry-run session is on.
func realSession(st focus.State) bool {
	return st.Session != nil && st.Session.EndedAt == 0 && !st.Session.DryRun && !st.DryRun
}

// quitDeps are the seams of the quit gate.
type quitDeps struct {
	eng          FocusEngine
	shuttingDown func() bool
	showFocus    func()
}

// shouldQuit implements SPEC.md §2.4: refuse while a real session is on and
// the quit isn't released; ask for the friction and open Focus. At Strict the
// engine refuses the request (only Emergency unlock exists); the quit is
// still refused and Focus still opens. Never blocks an OS shutdown.
// blocked is set when a quit was refused, so a later release quits.
func shouldQuit(d quitDeps, blocked *atomic.Bool) bool {
	if d.eng == nil {
		return true
	}
	if d.shuttingDown != nil && d.shuttingDown() {
		return true
	}
	st := d.eng.State()
	if !realSession(st) || st.QuitReleased {
		return true
	}
	blocked.Store(true)
	_, _ = d.eng.RequestWeaken(focus.WeakenQuit, nil)
	if d.showFocus != nil {
		d.showFocus()
	}
	return false
}

// ShouldQuit is Wails' Options.ShouldQuit (SPEC.md §2.4).
func (s *Shell) ShouldQuit() bool {
	return shouldQuit(quitDeps{
		eng:          s.focusEngine(),
		shuttingDown: osShuttingDown,
		showFocus:    func() { go func() { _ = s.ShowMain(NavigateFocus) }() },
	}, &s.quitBlocked)
}

func (s *Shell) focusEngine() FocusEngine {
	if s.o.Focus == nil {
		return nil
	}
	return s.o.Focus
}

// watchFocus quits after a refused quit gets released and keeps the tray's
// countdown fresh. Called from Start.
func (s *Shell) watchFocus() {
	eng := s.focusEngine()
	if eng == nil {
		return
	}
	eng.Subscribe(func(st focus.State) {
		if st.QuitReleased && s.quitBlocked.CompareAndSwap(true, false) {
			go s.Quit()
		}
		s.tray.focusChanged(st)
	})
}

// startLastFocus starts a session with the last profile, minutes and the
// default strength (tray item and focusStart hotkey). Without a usable last
// profile it opens Focus instead.
func (s *Shell) startLastFocus() {
	eng := s.focusEngine()
	if eng == nil {
		return
	}
	req, ok := lastFocusRequest(eng)
	if !ok {
		_ = s.ShowMain(NavigateFocus)
		return
	}
	if _, err := eng.Begin(req); err != nil {
		_ = s.ShowMain(NavigateFocus)
	}
}

// lastProfile finds the profile of Settings.LastProfileID.
func lastProfile(eng FocusEngine) (focus.Profile, bool) {
	id := eng.Settings().LastProfileID
	if id == "" {
		return focus.Profile{}, false
	}
	ps, err := eng.Profiles()
	if err != nil {
		return focus.Profile{}, false
	}
	for _, p := range ps {
		if p.ID == id {
			return p, true
		}
	}
	return focus.Profile{}, false
}

func lastFocusRequest(eng FocusEngine) (focus.StartRequest, bool) {
	p, ok := lastProfile(eng)
	if !ok {
		return focus.StartRequest{}, false
	}
	set := eng.Settings()
	mins := set.LastMinutes
	if mins <= 0 {
		mins = focus.DefaultMinutes
	}
	strength := set.DefaultStrength
	if strength == "" {
		strength = focus.StrengthFirm
	}
	return focus.StartRequest{ProfileID: p.ID, Minutes: mins, Strength: strength}, true
}

// minutesLeft rounds up so the label never says 0 while time remains.
func minutesLeft(endsAtMs, nowMs int64) int {
	d := endsAtMs - nowMs
	if d <= 0 {
		return 0
	}
	return int((d + 59999) / 60000)
}

// focusLeftLabel is "42 min left" / "1 h 5 min left".
func focusLeftLabel(mins int) string {
	if mins >= 60 {
		if mins%60 == 0 {
			return fmt.Sprintf("%d h left", mins/60)
		}
		return fmt.Sprintf("%d h %d min left", mins/60, mins%60)
	}
	return fmt.Sprintf("%d min left", mins)
}

// focusTray fills the Focus fields of the tray state.
func focusTray(st *trayState, eng FocusEngine, now time.Time) {
	s := eng.State()
	if !s.Supported {
		return
	}
	if s.Session != nil && s.Session.EndedAt == 0 {
		st.FocusActive = true
		st.FocusLeft = focusLeftLabel(minutesLeft(s.Session.EndsAt, now.UnixMilli()))
		return
	}
	if p, ok := lastProfile(eng); ok {
		st.FocusStartName = strings.TrimSpace(p.Name)
	}
}

// focusChanged refreshes the menu and, while a session is on, once a minute
// so the "N min left" label stays right. No goroutine outlives the session:
// the timer reschedules itself only while active.
func (t *tray) focusChanged(st focus.State) {
	t.refresh()
	active := st.Session != nil && st.Session.EndedAt == 0
	t.mu.Lock()
	defer t.mu.Unlock()
	if !active {
		if t.focusTimer != nil {
			t.focusTimer.Stop()
			t.focusTimer = nil
		}
		return
	}
	if t.focusTimer == nil {
		t.focusTimer = time.AfterFunc(time.Minute, t.focusTick)
	}
}

func (t *tray) focusTick() {
	t.mu.Lock()
	t.focusTimer = nil
	t.mu.Unlock()
	eng := t.s.focusEngine()
	if eng == nil {
		return
	}
	t.focusChanged(eng.State())
}
