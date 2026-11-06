package pipelines

import (
	"encoding/json"
	"slices"
	"testing"

	"toolbox/core"
	"toolbox/core/focus"
	focusmod "toolbox/modules/focus"
)

// focusOnly templates need no tool pack: Focus Lock, Wait and Open in app are built in.
func focusOnly(tpl core.PipelineTemplate) bool {
	return tpl.ID == TplMusicSession || tpl.ID == TplPomodoro || tpl.ID == TplDeepWork
}

func focusOpts(t *testing.T, s core.PipelineStep) focusmod.StepOptions {
	t.Helper()
	var o focusmod.StepOptions
	if err := json.Unmarshal([]byte(s.OptionsJSON), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func TestMusicSession(t *testing.T) {
	p := template(t, TplMusicSession).Pipeline
	if len(p.Steps) != 3 {
		t.Fatalf("%d steps", len(p.Steps))
	}
	start, wait := focusOpts(t, p.Steps[0]), focusOpts(t, p.Steps[2])
	if start.Action != focusmod.ActionStart || start.Minutes != 90 || start.Strength != focus.StrengthFirm || start.ProfileID != "" {
		t.Errorf("start = %+v", start)
	}
	if wait.Action != focusmod.ActionWait {
		t.Errorf("wait = %+v", wait)
	}
	var open OpenStep
	if err := json.Unmarshal([]byte(p.Steps[1].OptionsJSON), &open); err != nil {
		t.Fatal(err)
	}
	if open.App != "" || open.Label != "Your DAW" || open.CloseWhen != CloseFocusEnds || open.Files != OpenFilesNone {
		t.Errorf("open = %+v", open)
	}
}

func TestPomodoro(t *testing.T) {
	p := template(t, TplPomodoro).Pipeline
	if len(p.Steps) != 11 {
		t.Fatalf("%d steps, want 11", len(p.Steps))
	}
	params := map[string]string{}
	for _, pp := range p.Params {
		params[pp.Name] = pp.Default
		if pp.Type != core.ValueNumber || pp.Label == "" || pp.Choices == nil {
			t.Errorf("param %+v", pp)
		}
	}
	if params["work_minutes"] != "25" || params["break_minutes"] != "5" || len(params) != 2 {
		t.Fatalf("params = %v", params)
	}
	var types []string
	for i, s := range p.Steps {
		types = append(types, s.Type)
		if s.From != "none" {
			t.Errorf("step %d reads %q", i+1, s.From)
		}
		switch {
		case s.Type == stFocus && focusOpts(t, s).Action == focusmod.ActionStart:
			if !slices.Equal(s.Binds, []core.StepBind{{Option: "/minutes", Var: "work_minutes"}}) {
				t.Errorf("step %d binds = %+v", i+1, s.Binds)
			}
		case s.Type == TypeWait:
			if !slices.Equal(s.Binds, []core.StepBind{{Option: "/minutes", Var: "break_minutes"}}) {
				t.Errorf("step %d binds = %+v", i+1, s.Binds)
			}
		case len(s.Binds) != 0:
			t.Errorf("step %d has binds %+v", i+1, s.Binds)
		}
	}
	want := []string{stFocus, stFocus, TypeWait, stFocus, stFocus, TypeWait, stFocus, stFocus, TypeWait, stFocus, stFocus}
	if !slices.Equal(types, want) {
		t.Errorf("types = %v", types)
	}
}

func TestDeepWorkSchedule(t *testing.T) {
	p := template(t, TplDeepWork).Pipeline
	if len(p.Steps) != 1 {
		t.Fatalf("%d steps", len(p.Steps))
	}
	o := focusOpts(t, p.Steps[0])
	if o.Mode != focusmod.ModeUntil || o.At != "12:00" || o.Strength != focus.StrengthStrict {
		t.Errorf("focus = %+v", o)
	}
	sc := p.Schedule
	if !slices.Equal(sc.Days, []int{1, 2, 3, 4, 5}) || !slices.Equal(sc.Times, []string{"09:30"}) || sc.Enabled {
		t.Errorf("schedule = %+v", sc)
	}
}

func TestSampleThenMake(t *testing.T) {
	p := template(t, TplSampleAndMake).Pipeline
	if len(p.Steps) != 6 || p.Steps[0].From != "none" || p.Steps[1].From != "input" || p.Steps[5].From != "none" {
		t.Fatalf("steps = %+v", p.Steps)
	}
	if o := focusOpts(t, p.Steps[0]); o.Minutes != 120 || o.Mode != focusmod.ModeFor {
		t.Errorf("focus = %+v", o)
	}
	var rn RenameStep
	_ = json.Unmarshal([]byte(p.Steps[4].OptionsJSON), &rn)
	if rn.Template != "{name} · {bpm} BPM · {key}" {
		t.Errorf("rename = %q", rn.Template)
	}
}

// TakesFiles and the schedule are judged by the runner's own check.
func TestFocusTemplatesTakeFilesOrNot(t *testing.T) {
	runner := realRunner(t)
	for id, takes := range map[string]bool{TplMusicSession: false, TplPomodoro: false, TplDeepWork: false, TplSampleAndMake: true} {
		check := runner.Describe(template(t, id).Pipeline)
		if check.TakesFiles != takes {
			t.Errorf("%s: TakesFiles = %v, want %v", id, check.TakesFiles, takes)
		}
	}
	// A schedule on a pipeline that reads nothing validates once switched on.
	p, err := FromTemplate(TplDeepWork, nil)
	if err != nil {
		t.Fatal(err)
	}
	p.Schedule.Enabled = true
	if check := runner.Describe(p); len(check.Problems) != 0 {
		t.Errorf("problems = %v", check.Problems)
	}
}

// fakeFocus is the slice of the engine that describing a Focus step touches.
type fakeFocus struct{ focusmod.Engine }

func (fakeFocus) State() focus.State { return focus.State{Supported: true} }
func (fakeFocus) Profiles() ([]focus.Profile, error) {
	return []focus.Profile{}, nil
}

func TestPomodoroBindsSurviveFromTemplate(t *testing.T) {
	p, err := FromTemplate(TplPomodoro, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Steps[0].Binds[0].Var != "work_minutes" || len(p.Params) != 2 || p.Steps[1].From != "none" {
		t.Errorf("copy = %+v", p)
	}
}
