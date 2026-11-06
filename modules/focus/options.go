package focus

import (
	"toolbox/core"
	"toolbox/core/focus"
)

// Step actions (SPEC.md §4.1).
const (
	ActionStart = "start"
	ActionWait  = "wait"
	ActionEnd   = "end"
)

// Start modes.
const (
	ModeFor   = "for"
	ModeUntil = "until"
)

// IfActive values: what Start does when a session is already on.
const (
	IfActiveExtend = "extend"
	IfActiveWait   = "wait"
	IfActiveFail   = "fail"
)

// StepOptions are the Focus step's options.
type StepOptions struct {
	Action    string            `json:"action"`    // ActionStart | ActionWait | ActionEnd
	ProfileID string            `json:"profileId"` // start; "" = a problem ("Pick a profile")
	Mode      string            `json:"mode"`      // start: ModeFor | ModeUntil
	Minutes   int               `json:"minutes"`   // 1–720
	At        string            `json:"at"`        // until: "HH:MM" 24 h local
	Strength  focus.Strength    `json:"strength"`
	Extra     []focus.AllowRule `json:"extra"`    // ≤ 20
	OnStart   string            `json:"onStart"`  // focus.OnStartClose | focus.OnStartLeave
	IfActive  string            `json:"ifActive"` // IfActiveExtend | IfActiveWait | IfActiveFail
}

// DefaultStepOptions: start a 50 minute firm session.
func DefaultStepOptions() StepOptions {
	return StepOptions{
		Action: ActionStart, Mode: ModeFor, Minutes: focus.DefaultMinutes, At: "17:00",
		Strength: focus.StrengthFirm, Extra: []focus.AllowRule{}, OnStart: focus.OnStartClose, IfActive: IfActiveExtend,
	}
}

// JobOptions are a focus job's options (made by PrepareStep).
type JobOptions struct {
	Action   string              `json:"action"` // ActionStart | ActionEnd
	Start    *focus.StartRequest `json:"start"`
	IfActive string              `json:"ifActive"`
	RunID    string              `json:"runId"`
	Carry    []core.RunFile      `json:"carry"` // the step's files, passed on unchanged
}

// JobResult is what a focus job records (its step variables and the files it
// passes through).
type JobResult struct {
	Session *focus.Session    `json:"session"`
	Vars    map[string]string `json:"vars"`  // focus_ends, focus_minutes, focus_profile
	Files   []core.RunFile    `json:"files"` // the files passed through
}
