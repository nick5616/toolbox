package focus

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/focus"
)

var _ core.Chainable = (*Module)(nil)

const unsupportedMsg = "Focus Lock works on Windows and macOS"

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

func decodeStep(raw json.RawMessage) (StepOptions, error) {
	o := DefaultStepOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	// Decode over the defaults so omitted fields keep them.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	if o.Extra == nil {
		o.Extra = []focus.AllowRule{}
	}
	return o, nil
}

func (m *Module) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// parseAt reads "HH:MM" (24 h).
func parseAt(s string) (h, min int, ok bool) {
	hs, ms, found := strings.Cut(strings.TrimSpace(s), ":")
	if !found || len(hs) < 1 || len(hs) > 2 || len(ms) != 2 {
		return 0, 0, false
	}
	h, err1 := strconv.Atoi(hs)
	min, err2 := strconv.Atoi(ms)
	if err1 != nil || err2 != nil || h < 0 || h > 23 || min < 0 || min > 59 {
		return 0, 0, false
	}
	return h, min, true
}

// nextAt is the next local moment at HH:MM after now: today when it is still
// ahead, else tomorrow.
func nextAt(now time.Time, at string) (time.Time, bool) {
	h, min, ok := parseAt(at)
	if !ok {
		return time.Time{}, false
	}
	t := time.Date(now.Year(), now.Month(), now.Day(), h, min, 0, 0, now.Location())
	if !t.After(now) {
		t = time.Date(now.Year(), now.Month(), now.Day()+1, h, min, 0, 0, now.Location())
	}
	return t, true
}

func clockText(ms int64) string { return time.UnixMilli(ms).Format("15:04") }

// DescribeStep implements core.Chainable. It always returns a full StepInfo,
// together with the first problem as an error.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	info := core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, URLs: true, Any: true}, NoFiles: true,
		Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: []string{}, Warnings: []string{}, Summary: "Focus",
	}
	o, err := decodeStep(options)
	if err != nil {
		return info, err
	}
	if o.Action == ActionStart {
		info.Vars = []core.StepVar{
			{Name: "focus_ends", Label: "Focus ends (HH:MM)", Type: core.ValueText},
			{Name: "focus_minutes", Label: "Focus minutes", Type: core.ValueNumber},
			{Name: "focus_profile", Label: "Focus profile", Type: core.ValueText},
		}
	}
	switch o.Action {
	case ActionWait:
		info.Summary = "Wait until focus ends"
	case ActionEnd:
		info.Summary = "End the focus session"
	case ActionStart:
		info.Summary = m.startSummary(o)
	default:
		return info, field("action", "Pick start, wait or end")
	}
	if st := m.eng.State(); !st.Supported {
		msg := st.Unsupported
		if msg == "" {
			msg = unsupportedMsg
		}
		return info, core.ValidationError(msg, nil)
	}
	if o.Action != ActionStart {
		return info, nil
	}
	return info, m.checkStart(o)
}

func field(name, msg string) error {
	return core.ValidationError(msg, map[string]string{name: msg})
}

func (m *Module) profileName(id string) (string, bool) {
	if id == "" {
		return "", false
	}
	ps, err := m.eng.Profiles()
	if err != nil {
		return "", true // can't tell: don't claim it's missing
	}
	for _, p := range ps {
		if p.ID == id {
			return p.Name, true
		}
	}
	return "", false
}

func (m *Module) startSummary(o StepOptions) string {
	parts := []string{"Focus"}
	if name, ok := m.profileName(o.ProfileID); ok && name != "" {
		parts = append(parts, name)
	} else if o.ProfileID == "" {
		parts = append(parts, "no profile")
	}
	if o.Mode == ModeUntil {
		parts = append(parts, "until "+strings.TrimSpace(o.At))
	} else {
		parts = append(parts, fmt.Sprintf("%d min", o.Minutes))
	}
	parts = append(parts, string(o.Strength))
	return strings.Join(parts, " · ")
}

func (m *Module) checkStart(o StepOptions) error {
	if o.ProfileID == "" {
		return field("profileId", "Pick a profile")
	}
	if _, ok := m.profileName(o.ProfileID); !ok {
		return field("profileId", "That profile doesn't exist any more")
	}
	switch o.Mode {
	case ModeFor:
		if o.Minutes < 1 || o.Minutes > focus.MaxMinutes {
			return field("minutes", "Focus for 1 to 720 minutes")
		}
	case ModeUntil:
		if _, _, ok := parseAt(o.At); !ok {
			return field("at", "Enter a time like 17:30")
		}
	default:
		return field("mode", "Pick for or until")
	}
	switch o.Strength {
	case focus.StrengthSoft, focus.StrengthFirm, focus.StrengthStrict:
	default:
		return field("strength", "Pick soft, firm or strict")
	}
	switch o.OnStart {
	case focus.OnStartClose, focus.OnStartLeave:
	default:
		return field("onStart", "Pick close or leave")
	}
	switch o.IfActive {
	case IfActiveExtend, IfActiveWait, IfActiveFail:
	default:
		return field("ifActive", "Pick what to do when a session is already on")
	}
	if len(o.Extra) > focus.MaxExtra {
		return field("extra", fmt.Sprintf("At most %d extra apps", focus.MaxExtra))
	}
	for _, r := range o.Extra {
		if err := focus.CheckRule(r); err != nil {
			return err
		}
	}
	return nil
}

// passFiles are an item's files as the step hands them on.
func passFiles(files []core.RunFile) []core.RunFile {
	return append([]core.RunFile{}, files...)
}

func filePaths(files []core.RunFile) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Path)
	}
	return out
}

// PrepareStep implements core.Chainable (SPEC.md §4.1).
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	state := m.eng.State()
	if !state.Supported {
		msg := state.Unsupported
		if msg == "" {
			msg = unsupportedMsg
		}
		return nil, core.Errorf(focus.CodeUnsupported, "%s", msg)
	}
	active := state.Session
	files := req.Item.Files

	switch o.Action {
	case ActionWait:
		if active == nil || req.SkipWait {
			return nil, nil // done: the files pass through
		}
		return nil, core.ErrWaitingUntil("Focus until "+clockText(active.EndsAt), "", time.UnixMilli(active.EndsAt))

	case ActionEnd:
		return []core.StepJob{{
			Inputs:  filePaths(files),
			Options: JobOptions{Action: ActionEnd, RunID: req.RunID, Carry: passFiles(files)},
		}}, nil

	case ActionStart:
		if err := m.checkStart(o); err != nil {
			return nil, err
		}
		if active != nil {
			switch {
			case o.IfActive == IfActiveFail:
				return nil, core.Errorf(focus.CodeActive, "A focus session is already on").
					WithHint("End it first, or let this step extend it")
			case o.IfActive == IfActiveWait && !req.SkipWait:
				return nil, core.ErrWaitingUntil("Waiting for the focus session to end", "", time.UnixMilli(active.EndsAt))
			}
		}
		sr := focus.StartRequest{
			ProfileID: o.ProfileID, Strength: o.Strength, Extra: o.Extra, OnStart: o.OnStart,
			RunID: req.RunID, StepID: req.StepID,
		}
		if sr.Extra == nil {
			sr.Extra = []focus.AllowRule{}
		}
		if o.Mode == ModeUntil {
			now := m.clock()
			t, _ := nextAt(now, o.At)
			if active != nil && t.Day() != now.Day() {
				// A session is on and today's time has passed: that time is
				// reached. Don't roll to tomorrow (it would stretch the session).
				note := fmt.Sprintf("%s has passed today and a session is already on: nothing to extend", o.At)
				return []core.StepJob{{
					Inputs:  filePaths(files),
					Options: JobOptions{Action: ActionStart, Start: &sr, IfActive: o.IfActive, RunID: req.RunID, Carry: passFiles(files), Reached: true, Note: note},
				}}, nil
			}
			if t.Sub(now) > time.Duration(focus.MaxMinutes)*time.Minute {
				if t.Day() != now.Day() {
					return nil, field("at", fmt.Sprintf("%s has passed today and tomorrow's is more than 12 h away", o.At))
				}
				return nil, field("at", fmt.Sprintf("%s is more than 12 h away", o.At))
			}
			sr.Until = t.UnixMilli()
		} else {
			sr.Minutes = o.Minutes
		}
		return []core.StepJob{{
			Inputs:  filePaths(files),
			Options: JobOptions{Action: ActionStart, Start: &sr, IfActive: o.IfActive, RunID: req.RunID, Carry: passFiles(files)},
		}}, nil
	}
	return nil, field("action", "Pick start, wait or end")
}

// StepOutputs implements core.Chainable: the files the step was given, and
// the session variables of a start.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	if strings.TrimSpace(job.ResultJSON) != "" {
		var r JobResult
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
			return res, fmt.Errorf("reading the result of job %s: %w", job.ID, err)
		}
		if r.Files != nil {
			res.Files = r.Files
		}
		for k, v := range r.Vars {
			res.Vars[k] = v
		}
		if r.Files != nil {
			return res, nil
		}
	}
	// No carried files recorded: hand the inputs on.
	for _, p := range job.Inputs {
		res.Files = append(res.Files, core.RunFile{Path: p})
	}
	return res, nil
}

// ---- the job -----------------------------------------------------------------

// Run implements core.Module: start or end a session for a pipeline step.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[JobOptions](job)
	if err != nil {
		return err
	}
	carry := o.Carry
	if carry == nil {
		carry = []core.RunFile{}
		for _, p := range job.Inputs {
			carry = append(carry, core.RunFile{Path: p})
		}
	}
	res := JobResult{Vars: map[string]string{}, Files: carry}

	switch o.Action {
	case ActionStart:
		job.SetTitle("Start focus")
		if o.Start == nil {
			return core.ValidationError("Missing session settings", nil)
		}
		if o.Reached {
			res.Session = m.eng.State().Session
			res.Vars = map[string]string{"focus_ends": "", "focus_minutes": "", "focus_profile": ""}
			if res.Session != nil {
				res.Vars = sessionVars(*res.Session, m.clock())
			}
			job.Logf("%s", o.Note)
			job.Progress(1, "Done")
			return job.SetResult(res)
		}
		sess, err := m.startOrExtend(o)
		if err != nil {
			return err
		}
		res.Session = &sess
		res.Vars = sessionVars(sess, m.clock())
		job.Logf("Focus on until %s (%s)", clockText(sess.EndsAt), sess.Profile.Name)
		m.woke()

	case ActionEnd:
		job.SetTitle("End focus")
		had := m.eng.State().Session != nil
		if err := m.eng.EndFor(o.RunID); err != nil {
			return err
		}
		if had {
			job.Logf("Focus ended")
		} else {
			job.Logf("No focus session was on")
		}
		m.woke()

	default:
		return core.ValidationError("Unknown focus action", nil)
	}
	job.Progress(1, "Done")
	return job.SetResult(res)
}

// startOrExtend begins the session, or, when one is already on, extends it
// to this step's end (never earlier, never changing extras or strength).
func (m *Module) startOrExtend(o JobOptions) (focus.Session, error) {
	req := *o.Start
	if cur := m.eng.State().Session; cur != nil {
		return m.extendActive(cur, req, o.IfActive)
	}
	sess, err := m.eng.Begin(req)
	if err != nil {
		if core.AsAppError(err).Code == focus.CodeActive && o.IfActive != IfActiveFail {
			if cur := m.eng.State().Session; cur != nil { // lost a race
				return m.extendActive(cur, req, o.IfActive)
			}
		}
		return focus.Session{}, err
	}
	return sess, nil
}

func (m *Module) extendActive(cur *focus.Session, req focus.StartRequest, ifActive string) (focus.Session, error) {
	if ifActive == IfActiveFail {
		return focus.Session{}, core.Errorf(focus.CodeActive, "A focus session is already on")
	}
	end := req.Until
	if end == 0 {
		end = m.clock().Add(time.Duration(req.Minutes) * time.Minute).UnixMilli()
	}
	if end <= cur.EndsAt {
		return *cur, nil // never shortens
	}
	return m.eng.ExtendTo(end)
}

// sessionVars are a start step's variables.
func sessionVars(s focus.Session, now time.Time) map[string]string {
	left := (s.EndsAt - now.UnixMilli() + 59999) / 60000
	if left < 1 {
		left = 1
	}
	return map[string]string{
		"focus_ends":    clockText(s.EndsAt),
		"focus_minutes": strconv.FormatInt(left, 10),
		"focus_profile": s.Profile.Name,
	}
}

func (m *Module) woke() {
	if m.wake != nil {
		m.wake()
	}
}
