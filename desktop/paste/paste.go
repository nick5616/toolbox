// Package paste implements opt-in auto-paste for the clipboard popup
// (Phase 4 SPEC §13.2): remember the previously focused window or app,
// then re-activate it and send exactly one paste chord.
//
// It deliberately has no Wails dependency so it cross-compiles and vets for
// every OS. The OS specifics live behind the small Platform seam; tests drive
// the Orchestrator with fakes only and never inject real keystrokes.
package paste

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Permission states reported by Paster.Permission.
const (
	Granted     = "granted"
	Denied      = "denied"
	Unsupported = "unsupported"
)

// Errors returned by Paste. They are informational: the item stays copied.
var (
	ErrUnsupported   = errors.New("auto-paste isn't supported on this OS")
	ErrNoPermission  = errors.New("auto-paste isn't permitted (Accessibility permission missing)")
	ErrNothingStored = errors.New("no previous window was remembered")
	ErrTargetGone    = errors.New("the previous window or app is gone")
	ErrModifiersHeld = errors.New("modifier keys were still held; skipped pasting")
)

// Paster restores focus to the app that was active before the popup opened
// and sends one paste chord.
type Paster interface {
	// Remember records the currently focused window/app (ignoring our own).
	Remember()
	// Paste re-activates the remembered window/app, waits for modifier keys
	// to be released, and sends Ctrl+V / Cmd+V once.
	Paste(ctx context.Context) error
	// Permission reports Granted, Denied or Unsupported.
	Permission() string
	// RequestPermission prompts for the permission where the OS has one.
	RequestPermission() error
}

// Target identifies a window (HWND on Windows) or app (PID on macOS).
// Zero means none.
type Target uintptr

// Platform is the OS seam. Nothing in the Orchestrator touches the OS except
// through it.
type Platform interface {
	// Foreground returns the focused window/app and whether it belongs to
	// our own process. A zero Target means there is none.
	Foreground() (t Target, own bool)
	// Alive reports whether the target still exists.
	Alive(t Target) bool
	// Activate brings the target to the foreground.
	Activate(t Target) error
	// ModifiersHeld reports whether any of Ctrl/Alt/Shift/Win(Cmd) is down.
	ModifiersHeld() bool
	// SendPaste sends exactly one paste chord.
	SendPaste() error
	Permission() string
	RequestPermission() error
}

// Timing of the paste sequence (SPEC §13.2).
const (
	DefaultPollEvery = 15 * time.Millisecond
	DefaultMaxWait   = time.Second
	DefaultSettle    = 60 * time.Millisecond
)

// Orchestrator implements Paster on top of a Platform.
type Orchestrator struct {
	P         Platform
	PollEvery time.Duration
	MaxWait   time.Duration
	Settle    time.Duration
	// Sleep waits d or returns ctx's error. Defaults to a real timer.
	Sleep func(ctx context.Context, d time.Duration) error

	mu     sync.Mutex
	target Target
}

// NewOrchestrator returns an Orchestrator with the spec timings.
func NewOrchestrator(p Platform) *Orchestrator {
	return &Orchestrator{P: p, PollEvery: DefaultPollEvery, MaxWait: DefaultMaxWait, Settle: DefaultSettle}
}

func (o *Orchestrator) sleep(ctx context.Context, d time.Duration) error {
	if o.Sleep != nil {
		return o.Sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Remember stores the focused window unless it is ours (or there is none),
// in which case any earlier memory is dropped so we never paste somewhere stale.
func (o *Orchestrator) Remember() {
	t, own := o.P.Foreground()
	o.mu.Lock()
	defer o.mu.Unlock()
	if own || t == 0 {
		o.target = 0
		return
	}
	o.target = t
}

// Paste runs: permission check, activate, wait for modifiers, settle, chord.
// The remembered target is consumed, so one pick pastes at most once.
func (o *Orchestrator) Paste(ctx context.Context) error {
	switch o.P.Permission() {
	case Unsupported:
		return ErrUnsupported
	case Granted:
	default:
		return ErrNoPermission
	}
	o.mu.Lock()
	t := o.target
	o.target = 0
	o.mu.Unlock()
	if t == 0 {
		return ErrNothingStored
	}
	if !o.P.Alive(t) {
		return ErrTargetGone
	}
	if err := o.P.Activate(t); err != nil {
		return err
	}
	for waited := time.Duration(0); o.P.ModifiersHeld(); waited += o.PollEvery {
		if waited >= o.MaxWait {
			return ErrModifiersHeld
		}
		if err := o.sleep(ctx, o.PollEvery); err != nil {
			return err
		}
	}
	if err := o.sleep(ctx, o.Settle); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return o.P.SendPaste()
}

// Permission reports the platform's permission state.
func (o *Orchestrator) Permission() string { return o.P.Permission() }

// RequestPermission prompts for the permission where the OS has one.
func (o *Orchestrator) RequestPermission() error { return o.P.RequestPermission() }

// New returns the Paster for this OS.
func New() Paster { return NewOrchestrator(newPlatform()) }
