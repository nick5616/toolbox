package desktop

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core/focus"
)

type fakeFocus struct {
	st       focus.State
	set      focus.Settings
	profiles []focus.Profile
	weakened []focus.Weaken
	weakErr  error
	started  []focus.StartRequest
}

func (f *fakeFocus) State() focus.State                 { return f.st }
func (f *fakeFocus) Subscribe(func(focus.State)) func() { return func() {} }
func (f *fakeFocus) Settings() focus.Settings           { return f.set }
func (f *fakeFocus) Profiles() ([]focus.Profile, error) { return f.profiles, nil }
func (f *fakeFocus) Begin(r focus.StartRequest) (focus.Session, error) {
	f.started = append(f.started, r)
	return focus.Session{}, nil
}
func (f *fakeFocus) RequestWeaken(a focus.Weaken, _ *focus.AllowRule) (focus.Friction, error) {
	f.weakened = append(f.weakened, a)
	return focus.Friction{}, f.weakErr
}

func session(dry bool) *focus.Session {
	return &focus.Session{ID: "s", StartedAt: 1, EndsAt: 10 * 60000, DryRun: dry}
}

func TestShouldQuit(t *testing.T) {
	cases := []struct {
		name     string
		st       focus.State
		down     bool
		strict   bool
		want     bool
		weakened bool
	}{
		{"no session", focus.State{}, false, false, true, false},
		{"dry run session", focus.State{Session: session(true)}, false, false, true, false},
		{"dry run engine", focus.State{DryRun: true, Session: session(false)}, false, false, true, false},
		{"active", focus.State{Session: session(false)}, false, false, false, true},
		{"active strict", focus.State{Session: session(false)}, false, true, false, true},
		{"released", focus.State{Session: session(false), QuitReleased: true}, false, false, true, false},
		{"shutting down", focus.State{Session: session(false)}, true, false, true, false},
		{"ended", focus.State{Session: &focus.Session{EndedAt: 5}}, false, false, true, false},
	}
	for _, tc := range cases {
		f := &fakeFocus{st: tc.st}
		if tc.strict {
			f.weakErr = errors.New("conflict")
		}
		shown := 0
		var blocked atomic.Bool
		got := shouldQuit(quitDeps{eng: f, shuttingDown: func() bool { return tc.down }, showFocus: func() { shown++ }}, &blocked)
		if got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
		if (len(f.weakened) == 1) != tc.weakened || (shown == 1) != tc.weakened || blocked.Load() != tc.weakened {
			t.Errorf("%s: weakened=%v shown=%d blocked=%v", tc.name, f.weakened, shown, blocked.Load())
		}
	}
	var b atomic.Bool
	if !shouldQuit(quitDeps{}, &b) {
		t.Error("no engine must allow quit")
	}
}

func TestFocusTrayModel(t *testing.T) {
	has := func(m []trayItem, id string) (trayItem, bool) {
		for _, it := range m {
			if it.ID == id {
				return it, true
			}
		}
		return trayItem{}, false
	}
	m := trayModel(trayState{FocusActive: true, FocusLeft: "42 min left"})
	if it, ok := has(m, itemFocus); !ok || it.Label != "Focus · 42 min left" {
		t.Fatalf("active: %+v", m)
	}
	if _, ok := has(m, itemFocusStart); ok {
		t.Fatal("start shown while active")
	}
	m = trayModel(trayState{FocusStartName: "Writing"})
	if it, ok := has(m, itemFocusStart); !ok || it.Label != "Start focus (Writing)" {
		t.Fatalf("idle: %+v", m)
	}
	m = trayModel(trayState{})
	if _, ok := has(m, itemFocusStart); ok {
		t.Fatal("no profile: no item")
	}
	if _, ok := has(m, itemFocus); ok {
		t.Fatal("idle shows active item")
	}
}

func TestFocusLabels(t *testing.T) {
	for _, tc := range []struct {
		ends, now int64
		mins      int
		label     string
	}{
		{60000 * 42, 0, 42, "42 min left"},
		{60001, 0, 2, "2 min left"},
		{10, 0, 1, "1 min left"},
		{0, 5, 0, "0 min left"},
		{65 * 60000, 0, 65, "1 h 5 min left"},
		{120 * 60000, 0, 120, "2 h left"},
	} {
		m := minutesLeft(tc.ends, tc.now)
		if m != tc.mins || focusLeftLabel(m) != tc.label {
			t.Errorf("%d: %d %q", tc.ends, m, focusLeftLabel(m))
		}
	}
}

func TestFocusTrayAndStart(t *testing.T) {
	f := &fakeFocus{
		st:       focus.State{Supported: true},
		set:      focus.Settings{LastProfileID: "p2", LastMinutes: 25, DefaultStrength: focus.StrengthStrict},
		profiles: []focus.Profile{{ID: "p1", Name: "A"}, {ID: "p2", Name: " Writing "}},
	}
	var ts trayState
	focusTray(&ts, f, time.Unix(0, 0))
	if ts.FocusStartName != "Writing" || ts.FocusActive {
		t.Fatalf("%+v", ts)
	}
	req, ok := lastFocusRequest(f)
	if !ok || req.ProfileID != "p2" || req.Minutes != 25 || req.Strength != focus.StrengthStrict {
		t.Fatalf("%+v %v", req, ok)
	}
	f.set.LastProfileID = "gone"
	if _, ok := lastFocusRequest(f); ok {
		t.Fatal("unknown profile must not start")
	}
	f.st.Session = &focus.Session{EndsAt: 30 * 60000}
	ts = trayState{}
	focusTray(&ts, f, time.Unix(0, 0))
	if !ts.FocusActive || ts.FocusLeft != "30 min left" {
		t.Fatalf("%+v", ts)
	}
	f.st.Supported = false
	ts = trayState{}
	focusTray(&ts, f, time.Unix(0, 0))
	if ts.FocusActive || ts.FocusStartName != "" {
		t.Fatalf("unsupported: %+v", ts)
	}
}
