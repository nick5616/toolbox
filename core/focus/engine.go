package focus

import (
	"context"
	"time"

	"toolbox/core"
)

// Engine owns the focus session, the enforcement loop and learn mode.
// Wave 0 stub: the signatures are frozen; WP-F1 implements them.
type Engine struct {
	o Options
}

// New builds an Engine; nothing runs until Start.
func New(o Options) *Engine {
	if o.Clock == nil {
		o.Clock = time.Now
	}
	return &Engine{o: o}
}

func notYet() error { return core.NotImplemented("Focus Lock") }

// Start loads settings, prunes old events, resumes an active session
// (SPEC.md §2.5) and starts learn mode when it is on.
func (e *Engine) Start(ctx context.Context) error { return nil }

// Stop stops the loop. The active session stays in the store (it resumes at
// the next Start).
func (e *Engine) Stop() {}

// State is what the UI shows.
func (e *Engine) State() State { return State{Session: nil, StillOpen: []OpenApp{}} }

// Begin starts a session; CodeActive when one is on.
func (e *Engine) Begin(req StartRequest) (Session, error) { return Session{}, notYet() }

// Extend moves the end later by minutes (1–720), never past 12 h from the start.
func (e *Engine) Extend(minutes int) (Session, error) { return Session{}, notYet() }

// ExtendTo moves the end to until (Unix ms) when that is later; never earlier.
func (e *Engine) ExtendTo(until int64) (Session, error) { return Session{}, notYet() }

// RequestWeaken starts the friction for a weakening action (SPEC.md §2.3).
func (e *Engine) RequestWeaken(a Weaken, rule *AllowRule) (Friction, error) {
	return Friction{}, notYet()
}

// ConfirmWeaken checks the phrase and the countdown, then acts.
func (e *Engine) ConfirmWeaken(a Weaken, phrase string) error { return notYet() }

// CancelWeaken drops a friction in progress.
func (e *Engine) CancelWeaken() {}

// EndFor ends the session for a pipeline's End step: only a session runID
// started, or any soft one; CodeNotYours otherwise. No session = nil.
func (e *Engine) EndFor(runID string) error { return notYet() }

// CloseAgain asks a still-open app to close again.
func (e *Engine) CloseAgain(pid uint32, created int64) error { return notYet() }

// ForceClose terminates a still-open app (the user clicked Force close).
func (e *Engine) ForceClose(pid uint32, created int64) error { return notYet() }

// LeaveOpen drops a still-open app from the list and leaves it running.
func (e *Engine) LeaveOpen(pid uint32, created int64) {}

// NoteLaunch records an app Toolbox launched (Open in app) in the active
// session, so it stays allowed after a restart. No-op when idle.
func (e *Engine) NoteLaunch(path string) {}

// SetLearn turns learn mode on or off.
func (e *Engine) SetLearn(on bool) error { return notYet() }

// Resumed re-checks the session's end against the wall clock now (power resume).
func (e *Engine) Resumed() {}

// Subscribe calls fn (from the engine's goroutine; never block) whenever the
// State changes. It returns the unsubscribe function.
func (e *Engine) Subscribe(fn func(State)) (unsubscribe func()) { return func() {} }

// Profiles lists the saved profiles by name.
func (e *Engine) Profiles() ([]Profile, error) { return []Profile{}, nil }

// SaveProfile validates and stores a profile (new when ID is ""); CodeProfile
// or a validation error naming the bad rule.
func (e *Engine) SaveProfile(p Profile) (Profile, error) { return Profile{}, notYet() }

// DeleteProfile deletes a profile (an active session keeps its snapshot).
func (e *Engine) DeleteProfile(id string) error { return notYet() }

// Settings returns the standing settings.
func (e *Engine) Settings() Settings { return DefaultSettings() }

// SaveSettings validates and stores the settings. Always-allowed edits never
// change an active session (it holds a snapshot).
func (e *Engine) SaveSettings(s Settings) (Settings, error) { return Settings{}, notYet() }

// Blocked groups the active (or last) session's events by program, newest first.
func (e *Engine) Blocked(limit int) ([]BlockedApp, error) { return []BlockedApp{}, nil }

// Recent lists ended sessions, newest first.
func (e *Engine) Recent(limit int) ([]Session, error) { return []Session{}, nil }

// LearnList lists learn mode's would-stop programs since learn mode started.
func (e *Engine) LearnList() ([]LearnEntry, error) { return []LearnEntry{}, nil }

// IgnoreLearn forgets a program's learn entries ("" = all).
func (e *Engine) IgnoreLearn(path string) error { return notYet() }
