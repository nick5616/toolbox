// Package focus is Focus Lock's engine (SPEC.md §1–§2, Phase 18): while a
// session runs it watches every new process in the user's session, decides
// allow or block with a pure policy, and stops blocked ones. It never imports
// Wails, modules or core/store; the OS sits behind Platform and persistence
// behind Store.
//
// This file is the frozen Wave 0 contract.
package focus

import (
	"context"
	"errors"
	"time"

	"toolbox/core"
)

// Error codes (SPEC.md §1.2). Feature codes live in their package, as in
// core/lan.
const (
	CodeUnsupported core.ErrorCode = "focus_unsupported" // Focus Lock works on Windows and macOS
	CodeActive      core.ErrorCode = "focus_active"      // A focus session is already on
	CodeNotActive   core.ErrorCode = "focus_not_active"  // No focus session is on
	CodeNotYours    core.ErrorCode = "focus_not_yours"   // Another focus session is on
	CodePhrase      core.ErrorCode = "focus_phrase"      // That doesn't match the phrase
	CodeTooLong     core.ErrorCode = "focus_too_long"    // A session can last 12 hours at most
	CodeProfile     core.ErrorCode = "focus_profile"     // That profile needs a name and at least one app
	CodeCountdown   core.ErrorCode = "focus_countdown"   // Wait for the countdown to finish
)

// Event names (registered with Wails in api/events.go).
const (
	EventChanged = "focus:changed" // State
	EventBlocked = "focus:blocked" // BlockEvent
)

// Limits and defaults.
const (
	MaxMinutes     = 720 // 12 h
	MaxRules       = 100
	MaxExtra       = 20
	MaxProfileName = 40
	MaxRuleLabel   = 60
	// A snapshot costs ~4.5 ms on the Windows PC (359 processes, measured
	// 2026-11-05: 1.8% of a core at 250 ms), so the engine polls every second
	// and ticks at once on a window kick (Platform.Kicks).
	DefaultPollMs    = 1000
	MinPollMs        = 250
	MaxPollMs        = 2000
	DefaultMinutes   = 50
	StillOpenAfter   = 10 * time.Second
	FirmCountdown    = 30 * time.Second
	EmergencyWait    = 5 * time.Minute
	FailedTicksToEnd = 10
	EventsKeepDays   = 30
	EventsKeepRows   = 5000
	// Phrase is what firm and emergency weakening ask the user to type.
	Phrase = "I'm choosing to stop early"
)

// ErrGone is returned by Stopper methods when the process already exited (or
// its PID now belongs to another process).
var ErrGone = errors.New("process is gone")

// ProcInfo is one process. (PID, Created) identifies it; PIDs are reused.
type ProcInfo struct {
	PID       uint32 `json:"pid"`
	ParentPID uint32 `json:"parentPid"`
	Created   int64  `json:"created"` // creation time, Unix ms
	Session   uint32 `json:"session"` // Windows session ID; the real uid on macOS
	Path      string `json:"path"`    // full image path; "" if unknown (access denied) or not filled yet
	Name      string `json:"name"`    // exe name ("Discord.exe")
}

// ProcessSource lists processes. Snapshot leaves Path empty; Platform.Paths
// fills it for the processes the loop needs (only newly seen ones).
type ProcessSource interface {
	Snapshot(ctx context.Context) ([]ProcInfo, error)
}

// Stopper stops processes. Both methods re-check Created first and return
// ErrGone when it no longer matches.
type Stopper interface {
	Terminate(p ProcInfo) error          // TerminateProcess / SIGKILL
	AskToClose(p ProcInfo) (bool, error) // WM_CLOSE to its visible top-level windows / the app's own quit; false = it has none
}

// Platform is the OS seam (platform_windows.go, platform_darwin.go,
// platform_other.go; NewPlatform returns the current OS's).
type Platform interface {
	ProcessSource
	Stopper
	Paths(ps []ProcInfo)        // fills Path in place for these
	Windows() map[uint32]bool   // PIDs that own a visible top-level window
	Self() ProcInfo             // the Toolbox process
	InteractiveSession() uint32 // Self().Session
	SystemRoot() string         // Windows: GetSystemWindowsDirectory (long form, no trailing slash); macOS: "/System"
	Supported() error           // nil when enforcement works on this OS
	// Kicks fires (coalesced, never blocking) when the OS sees something that
	// may be a new program: Windows hooks EVENT_OBJECT_SHOW out of context
	// (SetWinEventHook, a locked OS thread with a message loop). The loop then
	// ticks at once instead of waiting for PollMs. nil = polling only. The
	// channel closes when ctx ends.
	Kicks(ctx context.Context) <-chan struct{}
}

// Options configure an Engine.
type Options struct {
	Platform Platform
	Store    Store
	Clock    func() time.Time // nil = time.Now
	DryRun   bool             // decide and log, never Terminate/AskToClose
	// Scope limits which processes the engine may act on. Tests only (the
	// real-platform E2E test); nil = every process in the session.
	Scope func(ProcInfo) bool
	// Emit sends EventChanged / EventBlocked. Optional.
	Emit func(name string, payload any)
}

// Rule kinds.
const (
	RuleFolder = "folder"
	RuleExe    = "exe"
)

// AllowRule allows one program or every program in a folder tree.
type AllowRule struct {
	ID       string `json:"id"`       // ULID
	Label    string `json:"label"`    // "Ableton Live 12", 1–60
	Kind     string `json:"kind"`     // RuleFolder | RuleExe
	Path     string `json:"path"`     // absolute; %VARS% kept; one "*" in one segment allowed
	Children bool   `json:"children"` // what it starts is allowed too (default true)
}

// Profile is a named set of allowed apps.
type Profile struct {
	ID        string      `json:"id"`    // ULID
	Name      string      `json:"name"`  // 1–40, unique ignoring case
	Rules     []AllowRule `json:"rules"` // 1–100
	CreatedAt int64       `json:"createdAt"`
	UpdatedAt int64       `json:"updatedAt"`
}

// Strength is how hard a session is to weaken (SPEC.md §2.3).
type Strength string

const (
	StrengthSoft   Strength = "soft"
	StrengthFirm   Strength = "firm"
	StrengthStrict Strength = "strict"
)

// OnStart values: what happens to blocked programs already open at start.
const (
	OnStartClose = "close" // ask windowed ones to close (default)
	OnStartLeave = "leave" // only block new launches
)

// End reasons.
const (
	EndTime      = "time"
	EndUser      = "user"
	EndEmergency = "emergency"
	EndPipeline  = "pipeline"
	EndError     = "error"
)

// Block event results.
const (
	ResultStopped   = "stopped"
	ResultClosed    = "closed"
	ResultFailed    = "failed"
	ResultWouldStop = "wouldStop" // dry run and learn mode
	ResultUnknown   = "unknown"   // allowed because its path couldn't be read
)

// StartRequest starts a session.
type StartRequest struct {
	ProfileID string      `json:"profileId"`
	Minutes   int         `json:"minutes"` // 1–720; or 0 with Until set
	Until     int64       `json:"until"`   // Unix ms; 1 min–12 h ahead
	Strength  Strength    `json:"strength"`
	Extra     []AllowRule `json:"extra"`   // this session only, ≤ 20
	OnStart   string      `json:"onStart"` // OnStartClose | OnStartLeave ("" = settings)
	RunID     string      `json:"runId"`   // set when a pipeline started it
	StepID    string      `json:"stepId"`
}

// Session is one focus session. It snapshots its rules at start, so editing
// a profile or Always allowed mid-session can't loosen it.
type Session struct {
	ID        string      `json:"id"`
	Profile   Profile     `json:"profile"` // snapshot
	Always    []AllowRule `json:"always"`  // snapshot of Settings.AlwaysAllowed
	Extra     []AllowRule `json:"extra"`
	Launched  []AllowRule `json:"launched"` // apps Toolbox launched in this session; confer
	Strength  Strength    `json:"strength"`
	OnStart   string      `json:"onStart"`
	StartedAt int64       `json:"startedAt"`
	EndsAt    int64       `json:"endsAt"`
	EndedAt   int64       `json:"endedAt"`   // 0 = active
	EndReason string      `json:"endReason"` // EndTime | EndUser | EndEmergency | EndPipeline | EndError
	RunID     string      `json:"runId"`
	StepID    string      `json:"stepId"`
	DryRun    bool        `json:"dryRun"`
	Blocked   int         `json:"blocked"` // count, for the summary
}

// BlockEvent is one decision worth showing: a stop, a failure, a would-stop.
type BlockEvent struct {
	SessionID string `json:"sessionId"` // "" in learn mode
	At        int64  `json:"at"`
	Path      string `json:"path"`
	Name      string `json:"name"`
	Result    string `json:"result"` // Result*
	Error     string `json:"error"`
}

// Settings are Focus Lock's standing settings (settings key "focus").
type Settings struct {
	AlwaysAllowed   []AllowRule `json:"alwaysAllowed"`   // ≤ 100
	DefaultStrength Strength    `json:"defaultStrength"` // firm
	OnStart         string      `json:"onStart"`         // close
	PollMs          int         `json:"pollMs"`          // 1000
	Learn           bool        `json:"learn"`
	LearnSince      int64       `json:"learnSince"`
	LastProfileID   string      `json:"lastProfileId"`
	LastMinutes     int         `json:"lastMinutes"` // 50
}

// DefaultSettings are the settings before the user changes anything.
func DefaultSettings() Settings {
	return Settings{
		AlwaysAllowed: []AllowRule{}, DefaultStrength: StrengthFirm, OnStart: OnStartClose,
		PollMs: DefaultPollMs, LastMinutes: DefaultMinutes,
	}
}

// OpenApp is a blocked program that was still open 10 s after an
// OnStartClose start.
type OpenApp struct {
	PID     uint32 `json:"pid"`
	Created int64  `json:"created"`
	Name    string `json:"name"`
	Path    string `json:"path"`
}

// Weaken is an action that weakens a session.
type Weaken string

const (
	WeakenEnd       Weaken = "end"
	WeakenAllow     Weaken = "allow"
	WeakenQuit      Weaken = "quit"
	WeakenEmergency Weaken = "emergency"
)

// Friction is a weakening in progress: the phrase to type and when Confirm
// enables. It lives in the engine, so closing the dialog doesn't reset it.
type Friction struct {
	Action  Weaken     `json:"action"`
	Phrase  string     `json:"phrase"`  // "" at soft
	ReadyAt int64      `json:"readyAt"` // Unix ms
	Rule    *AllowRule `json:"rule"`    // WeakenAllow
}

// State is what the UI shows; EventChanged carries it.
type State struct {
	Supported    bool      `json:"supported"`
	Unsupported  string    `json:"unsupported"` // why not, when !Supported
	OS           string    `json:"os"`          // "windows" | "darwin" | other GOOS
	DryRun       bool      `json:"dryRun"`
	Learn        bool      `json:"learn"`
	Session      *Session  `json:"session"`   // nil when idle
	Last         *Session  `json:"last"`      // the last ended session
	StillOpen    []OpenApp `json:"stillOpen"` // after an OnStartClose start
	Friction     *Friction `json:"friction"`
	QuitReleased bool      `json:"quitReleased"`
}

// LearnEntry groups learn-mode would-stops by program.
type LearnEntry struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Count    int    `json:"count"`
	LastSeen int64  `json:"lastSeen"`
}

// BlockedApp groups a session's events by program for "Blocked recently".
type BlockedApp struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Last   int64  `json:"last"`
	Result string `json:"result"` // the latest result
	Error  string `json:"error"`
}

// Store persists profiles, sessions, events and settings (core/store/focus.go).
type Store interface {
	Profiles(ctx context.Context) ([]Profile, error)
	PutProfile(ctx context.Context, p Profile) error
	DeleteProfile(ctx context.Context, id string) error
	ActiveSession(ctx context.Context) (*Session, error) // EndedAt = 0, newest; nil when none
	PutSession(ctx context.Context, s Session) error
	RecentSessions(ctx context.Context, limit int) ([]Session, error) // newest first, ended ones
	AddEvents(ctx context.Context, evs []BlockEvent) error
	Events(ctx context.Context, sessionID string, limit int) ([]BlockEvent, error) // newest first
	LearnEntries(ctx context.Context, since int64) ([]LearnEntry, error)           // wouldStop events with SessionID "", grouped by path
	ClearLearn(ctx context.Context, path string) error                             // "" = all
	PruneEvents(ctx context.Context, before int64, keep int) error
	GetSettings(ctx context.Context) (Settings, bool, error)
	PutSettings(ctx context.Context, s Settings) error
}
