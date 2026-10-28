package desktop

import (
	"strings"
	"sync"

	"toolbox/core"
)

// registrar is the part of Wails' GlobalShortcutManager the hotkey manager
// needs; tests use a fake.
type registrar interface {
	Register(accel string, cb func()) error
	Unregister(accel string) error
}

// hotkeyManager registers the configured global hotkeys.
type hotkeyManager struct {
	reg     registrar
	em      core.Emitter
	actions map[string]func() // action ID -> handler

	mu         sync.Mutex
	registered []string // accelerators we registered
	status     []core.HotkeyStatus
}

func newHotkeyManager(reg registrar, em core.Emitter, actions map[string]func()) *hotkeyManager {
	return &hotkeyManager{reg: reg, em: em, actions: actions, status: []core.HotkeyStatus{}}
}

// Apply unregisters everything it registered before, then registers every
// non-empty accelerator in core.HotkeyActions() order. Failures are reported
// per action and never fatal. It emits hotkeys:status afterwards.
func (m *hotkeyManager) Apply(hotkeys map[string]string) []core.HotkeyStatus {
	m.mu.Lock()
	for _, a := range m.registered {
		_ = m.reg.Unregister(a)
	}
	m.registered = nil

	out := make([]core.HotkeyStatus, 0, len(core.HotkeyActions()))
	for _, action := range core.HotkeyActions() {
		accel := hotkeys[action]
		st := core.HotkeyStatus{Action: action, Accelerator: accel}
		fn := m.actions[action]
		switch {
		case accel == "":
			// disabled
		case fn == nil:
			st.Error = "Unknown action"
		default:
			if err := safeRegister(m.reg, accel, fn); err != nil {
				st.Error = friendlyHotkeyError(err)
			} else {
				st.Registered = true
				m.registered = append(m.registered, accel)
			}
		}
		out = append(out, st)
	}
	m.status = out
	snapshot := append([]core.HotkeyStatus(nil), out...)
	m.mu.Unlock()

	if m.em != nil {
		m.em.Emit(core.EventHotkeysStatus, core.HotkeysChanged{Items: snapshot})
	}
	return snapshot
}

// Status returns the last Apply result.
func (m *hotkeyManager) Status() []core.HotkeyStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]core.HotkeyStatus{}, m.status...)
}

func safeRegister(r registrar, accel string, fn func()) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = errPanic{p}
		}
	}()
	return r.Register(accel, fn)
}

type errPanic struct{ v any }

func (e errPanic) Error() string { return "registration failed" }

func friendlyHotkeyError(err error) string {
	msg := err.Error()
	l := strings.ToLower(msg)
	if strings.Contains(l, "already") || strings.Contains(l, "in use") || strings.Contains(l, "1409") ||
		strings.Contains(l, "conflict") {
		return "In use by another app"
	}
	return msg
}
